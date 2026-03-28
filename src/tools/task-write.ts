import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AxiosInstance } from 'axios';
import { requireProject } from '../config.js';
import { getApiClient, formatApiError } from '../api.js';
import { ArtifactModeSchema, PlanSchema, TokensSchema, WalkthroughSchema } from '../schemas.js';
import { buildExecutionMetadata } from '../utils.js';
import { resolveTaskByIdentifier } from './task-common.js';

function renderPlanMarkdown(plan: z.infer<typeof PlanSchema>): string {
	const lines: string[] = [];
	lines.push('## Summary');
	lines.push(plan.summary);
	lines.push('');

	lines.push('## Steps');
	for (const step of plan.steps) {
		lines.push(`- ${step}`);
	}
	lines.push('');

	lines.push('## Files Affected');
	for (const file of plan.files_affected) {
		lines.push(`- \`${file}\``);
	}
	lines.push('');

	if (plan.risks?.length) {
		lines.push('## Risks');
		for (const risk of plan.risks) {
			lines.push(`- ${risk}`);
		}
		lines.push('');
	}

	if (plan.assumptions?.length) {
		lines.push('## Assumptions');
		for (const assumption of plan.assumptions) {
			lines.push(`- ${assumption}`);
		}
		lines.push('');
	}

	if (plan.open_questions?.length) {
		lines.push('## Open Questions');
		for (const question of plan.open_questions) {
			lines.push(`- ${question}`);
		}
		lines.push('');
	}

	if (plan.estimated_complexity) {
		lines.push('## Estimated Complexity');
		lines.push(plan.estimated_complexity);
		lines.push('');
	}

	if (plan.notes) {
		lines.push('## Notes');
		lines.push(plan.notes);
		lines.push('');
	}

	return lines.join('\n').trim();
}

function renderWalkthroughMarkdown(walkthrough: z.infer<typeof WalkthroughSchema>): string {
	const lines: string[] = [];
	lines.push('## Summary');
	lines.push(walkthrough.summary);
	lines.push('');

	lines.push('## Changes');
	for (const item of walkthrough.changes) {
		lines.push(`- ${item}`);
	}
	lines.push('');

	lines.push('## Files Modified');
	for (const file of walkthrough.files_modified) {
		lines.push(`- \`${file}\``);
	}
	lines.push('');

	if (walkthrough.decisions?.length) {
		lines.push('## Decisions');
		for (const decision of walkthrough.decisions) {
			lines.push(`- ${decision}`);
		}
		lines.push('');
	}

	if (walkthrough.testing?.length) {
		lines.push('## Testing');
		for (const test of walkthrough.testing) {
			lines.push(`- ${test}`);
		}
		lines.push('');
	}

	if (walkthrough.known_issues?.length) {
		lines.push('## Known Issues');
		for (const issue of walkthrough.known_issues) {
			lines.push(`- ${issue}`);
		}
		lines.push('');
	}

	if (walkthrough.next_steps?.length) {
		lines.push('## Next Steps');
		for (const next of walkthrough.next_steps) {
			lines.push(`- ${next}`);
		}
		lines.push('');
	}

	if (walkthrough.notes) {
		lines.push('## Notes');
		lines.push(walkthrough.notes);
		lines.push('');
	}

	return lines.join('\n').trim();
}

const WRITE_RETRY_ATTEMPTS = 3;
const WRITE_RETRY_BACKOFF_MS = 250;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

type TokenSource = 'exact' | 'estimate' | 'mixed';

interface TokenTotals {
	input?: number;
	output?: number;
	total?: number;
	estimate?: number;
}

interface ResolvedChatContext {
	chatId: string;
	chatName: string;
	sessionId: string;
}

function toFiniteNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function mergeTokenSources(a?: string, b?: string): TokenSource {
	const left = a as TokenSource | undefined;
	const right = b as TokenSource | undefined;
	if (!left && !right) return 'estimate';
	if (!left) return right ?? 'estimate';
	if (!right) return left;
	return left === right ? left : 'mixed';
}

function resolveTokens(content: string, provided?: z.infer<typeof TokensSchema>): { tokens: TokenTotals; tokenSource: TokenSource } {
	const estimate = Math.ceil(content.length / 4);
	if (!provided) {
		return { tokens: { estimate, total: estimate }, tokenSource: 'estimate' };
	}

	const parsedInput = toFiniteNumber(provided.input);
	const parsedOutput = toFiniteNumber(provided.output);
	const parsedTotalRaw = toFiniteNumber(provided.total);
	const parsedEstimate = toFiniteNumber(provided.estimate) ?? estimate;
	const derivedTotal =
		parsedTotalRaw ?? (parsedInput !== undefined && parsedOutput !== undefined ? parsedInput + parsedOutput : parsedEstimate);

	const hasAnyExact = parsedInput !== undefined || parsedOutput !== undefined || parsedTotalRaw !== undefined;
	const tokenSource: TokenSource = hasAnyExact
		? parsedTotalRaw !== undefined || (parsedInput !== undefined && parsedOutput !== undefined)
			? 'exact'
			: 'mixed'
		: 'estimate';

	return {
		tokens: {
			input: parsedInput,
			output: parsedOutput,
			total: derivedTotal,
			estimate: parsedEstimate
		},
		tokenSource
	};
}

function accumulateTotals(previous: unknown, delta: TokenTotals): TokenTotals {
	const prev = isRecord(previous) ? previous : {};
	const add = (left: unknown, right: number | undefined): number | undefined => {
		const base = toFiniteNumber(left);
		if (base === undefined && right === undefined) return undefined;
		return (base ?? 0) + (right ?? 0);
	};

	return {
		input: add(prev.input, delta.input),
		output: add(prev.output, delta.output),
		total: add(prev.total, delta.total),
		estimate: add(prev.estimate, delta.estimate)
	};
}

function buildAnalyticsState(options: {
	existingMcp: Record<string, unknown>;
	tokens: TokenTotals;
	tokenSource: TokenSource;
	chatId: string;
	chatName: string;
	sessionId: string;
	timestamp: string;
}): Record<string, unknown> {
	const existingAnalytics = isRecord(options.existingMcp.analytics) ? options.existingMcp.analytics : {};
	const existingChats = isRecord(existingAnalytics.chats) ? existingAnalytics.chats : {};

	const overallTotals = accumulateTotals(existingAnalytics.overallTokens, options.tokens);
	const overallSource = mergeTokenSources(
		typeof existingAnalytics.overallTokenSource === 'string' ? existingAnalytics.overallTokenSource : undefined,
		options.tokenSource
	);

	const chatKey = options.chatId || `session:${options.sessionId}`;
	const existingChat = isRecord(existingChats[chatKey]) ? existingChats[chatKey] : {};
	const chatTotals = accumulateTotals(existingChat.tokenTotals, options.tokens);
	const chatSource = mergeTokenSources(
		typeof existingChat.tokenSource === 'string' ? existingChat.tokenSource : undefined,
		options.tokenSource
	);

	return {
		...existingAnalytics,
		overallTokens: overallTotals,
		overallTokenSource: overallSource,
		chats: {
			...existingChats,
			[chatKey]: {
				...existingChat,
				chatId: options.chatId,
				chatName: options.chatName,
				sessionId: options.sessionId,
				lastSeenAt: options.timestamp,
				writes: (toFiniteNumber(existingChat.writes) ?? 0) + 1,
				tokenSource: chatSource,
				tokenTotals: chatTotals
			}
		}
	};
}

function pickString(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function pickHeaderValue(headers: unknown, keys: string[]): string | undefined {
	if (!isRecord(headers)) return undefined;

	for (const key of keys) {
		const directValue = headers[key];
		if (typeof directValue === 'string') {
			const trimmed = directValue.trim();
			if (trimmed.length > 0) return trimmed;
		}
		if (Array.isArray(directValue)) {
			const first = directValue.find((value) => typeof value === 'string' && value.trim().length > 0);
			if (typeof first === 'string') return first.trim();
		}
	}

	const lowered = Object.entries(headers).reduce<Record<string, unknown>>((acc, [key, value]) => {
		acc[key.toLowerCase()] = value;
		return acc;
	}, {});

	for (const key of keys) {
		const loweredValue = lowered[key.toLowerCase()];
		if (typeof loweredValue === 'string') {
			const trimmed = loweredValue.trim();
			if (trimmed.length > 0) return trimmed;
		}
		if (Array.isArray(loweredValue)) {
			const first = loweredValue.find((value) => typeof value === 'string' && value.trim().length > 0);
			if (typeof first === 'string') return first.trim();
		}
	}

	return undefined;
}

function resolveChatContext(options: {
	existingMcp: Record<string, unknown>;
	chatId?: string;
	chatName?: string;
	sessionId?: string;
	requestHeaders?: unknown;
}): ResolvedChatContext {
	const existingChat = isRecord(options.existingMcp.chat) ? options.existingMcp.chat : {};
	const headerChatName = pickHeaderValue(options.requestHeaders, [
		'x-chat-name',
		'x-chat-title',
		'x-thread-name',
		'x-thread-title',
		'x-codex-chat-name',
		'x-codex-chat-title'
	]);
	const headerChatId = pickHeaderValue(options.requestHeaders, ['x-chat-id', 'x-thread-id', 'x-codex-chat-id', 'x-codex-thread-id']);
	const resolvedSessionId = pickString(options.sessionId) ?? pickString(existingChat.sessionId) ?? 'session:unknown';
	const resolvedChatId =
		pickString(options.chatId) ??
		headerChatId ??
		pickString(existingChat.id) ??
		(resolvedSessionId === 'session:unknown' ? 'chat:unknown' : `session:${resolvedSessionId}`);
	const resolvedChatName =
		pickString(options.chatName) ??
		headerChatName ??
		pickString(existingChat.name) ??
		(resolvedChatId === 'chat:unknown' ? 'Unknown chat' : `Chat ${resolvedChatId}`);

	return {
		chatId: resolvedChatId,
		chatName: resolvedChatName,
		sessionId: resolvedSessionId
	};
}

async function patchTaskWithRetryAndVerification(
	api: AxiosInstance,
	projectId: string,
	taskId: string,
	payload: Record<string, unknown>,
	verify: (task: Awaited<ReturnType<typeof resolveTaskByIdentifier>>) => boolean
): Promise<void> {
	let lastError: unknown = undefined;

	for (let attempt = 1; attempt <= WRITE_RETRY_ATTEMPTS; attempt++) {
		try {
			await api.patch(`/projects/${projectId}/tasks/${taskId}`, payload);
			const persisted = await resolveTaskByIdentifier(api, projectId, taskId);
			if (verify(persisted)) return;
			lastError = new Error(`Verification failed after write (attempt ${attempt}/${WRITE_RETRY_ATTEMPTS}).`);
		} catch (error) {
			lastError = error;
		}

		if (attempt < WRITE_RETRY_ATTEMPTS) {
			await delay(WRITE_RETRY_BACKOFF_MS * attempt);
		}
	}

	if (lastError instanceof Error) {
		throw lastError;
	}
	throw new Error('Task write failed after retries.');
}

/**
 * Phase 2 + 3: Task write tools
 * PRD Sections 6.4, 8.2 (auto-inject execution_metadata on writes)
 */
export function registerTaskWriteTools(server: McpServer): void {
	// update_task_plan — PATCH with structured plan
	server.tool(
		'update_task_plan',
		'Submit or update an implementation plan for a task. The plan must follow the structured schema with summary, steps, files_affected, etc. Use this after retrieving compact context and analyzing the requirements. Stores full markdown plan plus structured schema in metadata.',
		{
			taskId: z.string().describe('Task ID (full UUID or truncated prefix)'),
			plan: PlanSchema,
			mode: ArtifactModeSchema.optional().describe('Optional artifact mode: "mini" fallback or "full" when a complete plan already exists.'),
			model: z.string().describe('Model used for this plan (e.g. "claude-sonnet-4-20250514")'),
			agent: z.string().describe('Agent/client name (e.g. "cursor", "claude-desktop")'),
			tokens: TokensSchema.optional().describe('Optional token usage for this write operation'),
			chat_id: z.string().optional().describe('Optional chat/thread identifier'),
			chat_name: z.string().optional().describe('Optional chat/thread display name')
		},
		{
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true
		},
		async ({ taskId, plan, mode, model, agent, tokens, chat_id, chat_name }, extra) => {
			try {
				// Validate plan schema
				const parsed = PlanSchema.parse(plan);
				const planContent = renderPlanMarkdown(parsed);
				const artifactMode = mode ?? 'mini';
				const resolvedTokens = resolveTokens(planContent, tokens);

				const config = requireProject();
				const projectId = config.currentProjectId;
				if (!projectId) throw new Error('NO_ACTIVE_PROJECT: No project selected.');
				const api = getApiClient();
				const currentTask = await resolveTaskByIdentifier(api, projectId, taskId);

				const existingMetadata = (currentTask.implementationMetadata as Record<string, unknown>) || {};
				const existingMcp = (existingMetadata.mcp as Record<string, unknown>) || {};
				const history = (existingMetadata.history as unknown[]) || [];
				const chatContext = resolveChatContext({
					existingMcp,
					chatId: chat_id,
					chatName: chat_name,
					sessionId: extra.sessionId,
					requestHeaders: extra.requestInfo?.headers
				});

				// Build execution metadata (Phase 3: auto-inject)
				const execution = buildExecutionMetadata(planContent, {
					model,
					agent,
					lastRetrievedAt: existingMetadata.lastRetrievedAt as string | undefined,
					sessionId: chatContext.sessionId,
					chatId: chatContext.chatId,
					chatName: chatContext.chatName,
					tokenSource: resolvedTokens.tokenSource,
					extraTokens: resolvedTokens.tokens
				});
				const timestamp = typeof execution.timestamp === 'string' ? execution.timestamp : new Date().toISOString();
				const analytics = buildAnalyticsState({
					existingMcp,
					tokens: resolvedTokens.tokens,
					tokenSource: resolvedTokens.tokenSource,
					chatId: chatContext.chatId,
					chatName: chatContext.chatName,
					sessionId: chatContext.sessionId,
					timestamp
				});

				const updatedMetadata = {
					...existingMetadata,
					mcp: {
						...existingMcp,
						planSchema: parsed,
						planArtifactMode: artifactMode,
						walkthroughSchema: isRecord(existingMcp.walkthroughSchema) ? existingMcp.walkthroughSchema : null,
						walkthroughArtifactMode:
							typeof existingMcp.walkthroughArtifactMode === 'string' ? existingMcp.walkthroughArtifactMode : null,
						chat: {
							id: chatContext.chatId,
							name: chatContext.chatName,
							sessionId: chatContext.sessionId,
							lastSeenAt: timestamp
						},
						analytics
					},
					lastExecution: execution,
					history: [
						...history,
						{
							...execution,
							action: 'update_plan',
							token_source: resolvedTokens.tokenSource,
							chat_id: chatContext.chatId,
							chat_name: chatContext.chatName,
							chat_title: chatContext.chatName,
							session_id: chatContext.sessionId,
							duration: execution.durationMs,
							executed_at: execution.timestamp,
							cumulativeTokens: analytics.overallTokens,
							total_tokens: isRecord(analytics.overallTokens) ? analytics.overallTokens.total : undefined,
							'total tokens': isRecord(analytics.overallTokens) ? analytics.overallTokens.total : undefined,
							git_branch: isRecord(execution.git) ? execution.git.branch : undefined,
							git_repo: isRecord(execution.git) ? execution.git.repo : undefined
						}
					]
				};

				await patchTaskWithRetryAndVerification(
					api,
					projectId,
					currentTask.id,
					{
					plan: planContent,
					implementationMetadata: updatedMetadata
					},
					(persistedTask) => {
						const persistedMetadata = (persistedTask.implementationMetadata as Record<string, unknown>) || {};
						const persistedMcp = isRecord(persistedMetadata.mcp) ? persistedMetadata.mcp : {};
						return (
							typeof persistedTask.plan === 'string' &&
							persistedTask.plan.trim() === planContent &&
							isRecord(persistedMcp.planSchema) &&
							persistedMcp.planArtifactMode === artifactMode
						);
					}
				);

				return {
					content: [
						{
							type: 'text' as const,
							text: `✔ Plan updated for task \`${currentTask.id.substring(0, 5)}\`.\n\n**Mode**: ${artifactMode}\n**Steps**: ${parsed.steps.length}\n**Files affected**: ${parsed.files_affected.length}\n**Complexity**: ${parsed.estimated_complexity || 'not specified'}`
						}
					]
				};
			} catch (error) {
				if (error instanceof z.ZodError) {
					const issues = error.issues.map((i) => `- ${i.path.join('.')}: ${i.message}`).join('\n');
					return {
						content: [{ type: 'text' as const, text: `INVALID_INPUT: Plan validation failed:\n${issues}` }],
						isError: true
					};
				}
				const err = formatApiError(error);
				return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
			}
		}
	);

	// update_task_walkthrough — PATCH with structured walkthrough
	server.tool(
		'update_task_walkthrough',
		'Submit or update an implementation walkthrough for a task. The walkthrough must follow the structured schema with summary, changes, files_modified, decisions, testing, etc. Stores full markdown walkthrough plus structured schema in metadata.',
		{
			taskId: z.string().describe('Task ID (full UUID or truncated prefix)'),
			walkthrough: WalkthroughSchema,
			mode: ArtifactModeSchema.optional().describe('Optional artifact mode: "mini" fallback or "full" when a complete walkthrough already exists.'),
			model: z.string().describe('Model used for this walkthrough'),
			agent: z.string().describe('Agent/client name'),
			tokens: TokensSchema.optional().describe('Optional token usage for this write operation'),
			chat_id: z.string().optional().describe('Optional chat/thread identifier'),
			chat_name: z.string().optional().describe('Optional chat/thread display name')
		},
		{
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true
		},
		async ({ taskId, walkthrough, mode, model, agent, tokens, chat_id, chat_name }, extra) => {
			try {
				const parsed = WalkthroughSchema.parse(walkthrough);
				const walkthroughContent = renderWalkthroughMarkdown(parsed);
				const artifactMode = mode ?? 'mini';
				const resolvedTokens = resolveTokens(walkthroughContent, tokens);

				const config = requireProject();
				const projectId = config.currentProjectId;
				if (!projectId) throw new Error('NO_ACTIVE_PROJECT: No project selected.');
				const api = getApiClient();
				const currentTask = await resolveTaskByIdentifier(api, projectId, taskId);

				const existingMetadata = (currentTask.implementationMetadata as Record<string, unknown>) || {};
				const existingMcp = (existingMetadata.mcp as Record<string, unknown>) || {};
				const history = (existingMetadata.history as unknown[]) || [];
				const chatContext = resolveChatContext({
					existingMcp,
					chatId: chat_id,
					chatName: chat_name,
					sessionId: extra.sessionId,
					requestHeaders: extra.requestInfo?.headers
				});

				const execution = buildExecutionMetadata(walkthroughContent, {
					model,
					agent,
					lastRetrievedAt: existingMetadata.lastRetrievedAt as string | undefined,
					sessionId: chatContext.sessionId,
					chatId: chatContext.chatId,
					chatName: chatContext.chatName,
					tokenSource: resolvedTokens.tokenSource,
					extraTokens: resolvedTokens.tokens
				});
				const timestamp = typeof execution.timestamp === 'string' ? execution.timestamp : new Date().toISOString();
				const analytics = buildAnalyticsState({
					existingMcp,
					tokens: resolvedTokens.tokens,
					tokenSource: resolvedTokens.tokenSource,
					chatId: chatContext.chatId,
					chatName: chatContext.chatName,
					sessionId: chatContext.sessionId,
					timestamp
				});

				const updatedMetadata = {
					...existingMetadata,
					mcp: {
						...existingMcp,
						walkthroughSchema: parsed,
						walkthroughArtifactMode: artifactMode,
						planSchema: isRecord(existingMcp.planSchema) ? existingMcp.planSchema : null,
						planArtifactMode: typeof existingMcp.planArtifactMode === 'string' ? existingMcp.planArtifactMode : null,
						chat: {
							id: chatContext.chatId,
							name: chatContext.chatName,
							sessionId: chatContext.sessionId,
							lastSeenAt: timestamp
						},
						analytics
					},
					lastExecution: execution,
					history: [
						...history,
						{
							...execution,
							action: 'update_walkthrough',
							token_source: resolvedTokens.tokenSource,
							chat_id: chatContext.chatId,
							chat_name: chatContext.chatName,
							chat_title: chatContext.chatName,
							session_id: chatContext.sessionId,
							duration: execution.durationMs,
							executed_at: execution.timestamp,
							cumulativeTokens: analytics.overallTokens,
							total_tokens: isRecord(analytics.overallTokens) ? analytics.overallTokens.total : undefined,
							'total tokens': isRecord(analytics.overallTokens) ? analytics.overallTokens.total : undefined,
							git_branch: isRecord(execution.git) ? execution.git.branch : undefined,
							git_repo: isRecord(execution.git) ? execution.git.repo : undefined
						}
					]
				};

				await patchTaskWithRetryAndVerification(
					api,
					projectId,
					currentTask.id,
					{
					walkthrough: walkthroughContent,
					implementationMetadata: updatedMetadata
					},
					(persistedTask) => {
						const persistedMetadata = (persistedTask.implementationMetadata as Record<string, unknown>) || {};
						const persistedMcp = isRecord(persistedMetadata.mcp) ? persistedMetadata.mcp : {};
						return (
							typeof persistedTask.walkthrough === 'string' &&
							persistedTask.walkthrough.trim() === walkthroughContent &&
							isRecord(persistedMcp.walkthroughSchema) &&
							persistedMcp.walkthroughArtifactMode === artifactMode
						);
					}
				);

				return {
					content: [
						{
							type: 'text' as const,
							text: `✔ Walkthrough updated for task \`${currentTask.id.substring(0, 5)}\`.\n\n**Mode**: ${artifactMode}\n**Changes**: ${parsed.changes.length}\n**Files modified**: ${parsed.files_modified.length}`
						}
					]
				};
			} catch (error) {
				if (error instanceof z.ZodError) {
					const issues = error.issues.map((i) => `- ${i.path.join('.')}: ${i.message}`).join('\n');
					return {
						content: [{ type: 'text' as const, text: `INVALID_INPUT: Walkthrough validation failed:\n${issues}` }],
						isError: true
					};
				}
				const err = formatApiError(error);
				return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
			}
		}
	);

	// update_task_metadata — PATCH for status/priority changes
	server.tool(
		'update_task_metadata',
		'Update task status, priority, or other metadata fields. Use this for lifecycle transitions (e.g. moving a task from "todo" to "in_progress" or marking it "done").',
		{
			taskId: z.string().describe('Task ID (full UUID or truncated prefix)'),
			status: z.string().optional().describe('New status: todo, in_progress, in_review, done, backlog, frozen'),
			priority: z.string().optional().describe('New priority: low, medium, high, urgent'),
			model: z.string().describe('Model used (for execution metadata tracking)'),
			agent: z.string().describe('Agent/client name'),
			tokens: TokensSchema.optional().describe('Optional token usage for this write operation'),
			chat_id: z.string().optional().describe('Optional chat/thread identifier'),
			chat_name: z.string().optional().describe('Optional chat/thread display name')
		},
		{
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true
		},
			async ({ taskId, status, priority, model, agent, tokens, chat_id, chat_name }, extra) => {
				try {
					const config = requireProject();
					const projectId = config.currentProjectId;
					if (!projectId) throw new Error('NO_ACTIVE_PROJECT: No project selected.');
					const api = getApiClient();
					const currentTask = await resolveTaskByIdentifier(api, projectId, taskId);
					const existingMetadata = (currentTask.implementationMetadata as Record<string, unknown>) || {};
					const mcp = isRecord(existingMetadata.mcp) ? existingMetadata.mcp : {};
					const chatContext = resolveChatContext({
						existingMcp: mcp,
						chatId: chat_id,
						chatName: chat_name,
						sessionId: extra.sessionId,
						requestHeaders: extra.requestInfo?.headers
					});

				if (status === 'in_progress') {
					const hasPlanText = typeof currentTask.plan === 'string' && currentTask.plan.trim().length > 0;
					const hasPlanSchema = isRecord(mcp.planSchema);
					const wasRetrievedViaFenkit = typeof existingMetadata.lastRetrievedAt === 'string';
					if (wasRetrievedViaFenkit && !hasPlanText && !hasPlanSchema) {
						return {
							content: [
								{
									type: 'text' as const,
									text:
										'INVALID_STATE: Cannot set task to `in_progress` without a persisted plan after Fenkit retrieval. Submit `update_task_plan` first (`full` if a full artifact exists, otherwise `mini`).'
								}
							],
							isError: true
						};
					}
				}

				if (status === 'done') {
					const hasWalkthroughText =
						typeof currentTask.walkthrough === 'string' && currentTask.walkthrough.trim().length > 0;
					const hasWalkthroughSchema = isRecord(mcp.walkthroughSchema);

					if (!hasWalkthroughText && !hasWalkthroughSchema) {
						return {
							content: [
								{
									type: 'text' as const,
									text:
										'INVALID_STATE: Cannot set task to `done` without a persisted walkthrough. Submit `update_task_walkthrough` first (mode `full` if a full artifact exists, otherwise `mini`).'
								}
							],
							isError: true
						};
					}
				}

				const updatePayload: Record<string, unknown> = {};
				if (status) updatePayload.status = status;
				if (priority) updatePayload.priority = priority;

				if (Object.keys(updatePayload).length === 0) {
					return {
						content: [{ type: 'text' as const, text: 'INVALID_INPUT: Must provide at least one of: status, priority' }],
						isError: true
					};
				}

				const history = (existingMetadata.history as unknown[]) || [];
				const resolvedTokens = resolveTokens(JSON.stringify(updatePayload), tokens);

				const execution = buildExecutionMetadata(JSON.stringify(updatePayload), {
					model,
					agent,
					lastRetrievedAt: existingMetadata.lastRetrievedAt as string | undefined,
					sessionId: chatContext.sessionId,
					chatId: chatContext.chatId,
					chatName: chatContext.chatName,
					tokenSource: resolvedTokens.tokenSource,
					extraTokens: resolvedTokens.tokens
				});
				const timestamp = typeof execution.timestamp === 'string' ? execution.timestamp : new Date().toISOString();
				const analytics = buildAnalyticsState({
					existingMcp: mcp,
					tokens: resolvedTokens.tokens,
					tokenSource: resolvedTokens.tokenSource,
					chatId: chatContext.chatId,
					chatName: chatContext.chatName,
					sessionId: chatContext.sessionId,
					timestamp
				});

				const changesSnapshot = { ...updatePayload };
				updatePayload.implementationMetadata = {
					...existingMetadata,
					mcp: {
						...mcp,
						planSchema: isRecord(mcp.planSchema) ? mcp.planSchema : null,
						planArtifactMode: typeof mcp.planArtifactMode === 'string' ? mcp.planArtifactMode : null,
						walkthroughSchema: isRecord(mcp.walkthroughSchema) ? mcp.walkthroughSchema : null,
						walkthroughArtifactMode: typeof mcp.walkthroughArtifactMode === 'string' ? mcp.walkthroughArtifactMode : null,
						chat: {
							id: chatContext.chatId,
							name: chatContext.chatName,
							sessionId: chatContext.sessionId,
							lastSeenAt: timestamp
						},
						analytics
					},
					lastExecution: execution,
					history: [
						...history,
						{
							...execution,
							action: 'update_metadata',
							changes: changesSnapshot,
							token_source: resolvedTokens.tokenSource,
							chat_id: chatContext.chatId,
							chat_name: chatContext.chatName,
							chat_title: chatContext.chatName,
							session_id: chatContext.sessionId,
							duration: execution.durationMs,
							executed_at: execution.timestamp,
							cumulativeTokens: analytics.overallTokens,
							total_tokens: isRecord(analytics.overallTokens) ? analytics.overallTokens.total : undefined,
							'total tokens': isRecord(analytics.overallTokens) ? analytics.overallTokens.total : undefined,
							git_branch: isRecord(execution.git) ? execution.git.branch : undefined,
							git_repo: isRecord(execution.git) ? execution.git.repo : undefined
						}
					]
				};

					await api.patch(`/projects/${projectId}/tasks/${currentTask.id}`, updatePayload);

				const changes = [];
				if (status) changes.push(`Status → ${status}`);
				if (priority) changes.push(`Priority → ${priority}`);

				return {
					content: [
						{
							type: 'text' as const,
							text: `✔ Task \`${currentTask.id.substring(0, 5)}\` updated: ${changes.join(', ')}`
						}
					]
				};
			} catch (error) {
				const err = formatApiError(error);
				return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
			}
		}
	);
}

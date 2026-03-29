import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AxiosInstance } from 'axios';
import { requireProject } from '../config.js';
import { getApiClient, formatApiError } from '../api.js';
import {
	ArtifactModeSchema,
	OperationIdSchema,
	PlanSchema,
	TaskIdentifierSchema,
	TaskPrioritySchema,
	TaskStatusSchema,
	TokensSchema,
	WalkthroughSchema
} from '../schemas.js';
import { resolveTaskByIdentifier } from './task-common.js';
import { extractPromptFromHeaders, stableHash, trackToolCall } from '../observability.js';

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
		for (const risk of plan.risks) lines.push(`- ${risk}`);
		lines.push('');
	}
	if (plan.assumptions?.length) {
		lines.push('## Assumptions');
		for (const assumption of plan.assumptions) lines.push(`- ${assumption}`);
		lines.push('');
	}
	if (plan.open_questions?.length) {
		lines.push('## Open Questions');
		for (const question of plan.open_questions) lines.push(`- ${question}`);
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
	for (const item of walkthrough.changes) lines.push(`- ${item}`);
	lines.push('');

	lines.push('## Files Modified');
	for (const file of walkthrough.files_modified) lines.push(`- \`${file}\``);
	lines.push('');

	if (walkthrough.decisions?.length) {
		lines.push('## Decisions');
		for (const decision of walkthrough.decisions) lines.push(`- ${decision}`);
		lines.push('');
	}
	if (walkthrough.testing?.length) {
		lines.push('## Testing');
		for (const test of walkthrough.testing) lines.push(`- ${test}`);
		lines.push('');
	}
	if (walkthrough.known_issues?.length) {
		lines.push('## Known Issues');
		for (const issue of walkthrough.known_issues) lines.push(`- ${issue}`);
		lines.push('');
	}
	if (walkthrough.next_steps?.length) {
		lines.push('## Next Steps');
		for (const next of walkthrough.next_steps) lines.push(`- ${next}`);
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

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function pickString(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function pickHeaderValue(headers: unknown, keys: string[]): string | undefined {
	if (!isRecord(headers)) return undefined;
	for (const key of keys) {
		const direct = headers[key];
		if (typeof direct === 'string' && direct.trim().length > 0) return direct.trim();
		if (Array.isArray(direct)) {
			const first = direct.find((value) => typeof value === 'string' && value.trim().length > 0);
			if (typeof first === 'string') return first.trim();
		}
	}
	return undefined;
}

function resolveChatContext(options: {
	chatId?: string;
	chatName?: string;
	sessionId?: string;
	requestHeaders?: unknown;
}): ResolvedChatContext {
	const headerChatName = pickHeaderValue(options.requestHeaders, [
		'x-chat-name',
		'x-chat-title',
		'x-thread-name',
		'x-thread-title',
		'x-codex-chat-name',
		'x-codex-chat-title'
	]);
	const headerChatId = pickHeaderValue(options.requestHeaders, ['x-chat-id', 'x-thread-id', 'x-codex-chat-id', 'x-codex-thread-id']);
	const sessionId = pickString(options.sessionId) ?? 'session:unknown';
	const chatId = pickString(options.chatId) ?? headerChatId ?? `session:${sessionId}`;
	const chatName = pickString(options.chatName) ?? headerChatName ?? `Chat ${chatId}`;

	return { chatId, chatName, sessionId };
}

function toFiniteNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function resolveTokens(
	content: string,
	provided?: z.infer<typeof TokensSchema>
): { tokens: TokenTotals; tokenSource: TokenSource } {
	const estimate = Math.ceil(content.length / 4);
	if (!provided) {
		return { tokens: { estimate, total: estimate }, tokenSource: 'estimate' };
	}

	const input = toFiniteNumber(provided.input);
	const output = toFiniteNumber(provided.output);
	const total = toFiniteNumber(provided.total);
	const estimateValue = toFiniteNumber(provided.estimate) ?? estimate;
	const derivedTotal = total ?? (input !== undefined && output !== undefined ? input + output : estimateValue);

	const hasAnyExact = input !== undefined || output !== undefined || total !== undefined;
	const tokenSource: TokenSource = hasAnyExact
		? total !== undefined || (input !== undefined && output !== undefined)
			? 'exact'
			: 'mixed'
		: 'estimate';

	return {
		tokens: { input, output, total: derivedTotal, estimate: estimateValue },
		tokenSource
	};
}

async function syncChatTaskBindingHeartbeatFromWrite(options: {
	projectId: string;
	taskId: string;
	status: string;
	lastTool: string;
	chatId?: string;
	requestHeaders?: unknown;
}): Promise<void> {
	const resolvedChatId =
		pickString(options.chatId) ??
		pickHeaderValue(options.requestHeaders, ['x-chat-id', 'x-thread-id', 'x-codex-chat-id', 'x-codex-thread-id']);
	if (!resolvedChatId) return;

	const api = getApiClient();
	await api.post('/mcp/chat-task-bindings/heartbeat', {
		chat_id: resolvedChatId,
		project_id: options.projectId,
		task_id: options.taskId,
		last_tool: options.lastTool,
		last_seen_at: new Date().toISOString(),
		status: options.status
	});
}

async function patchTaskWithRetryAndVerification(
	api: AxiosInstance,
	projectId: string,
	taskId: string,
	payload: Record<string, unknown>,
	verify: (task: Awaited<ReturnType<typeof resolveTaskByIdentifier>>) => boolean
): Promise<number> {
	let lastError: unknown = undefined;

	for (let attempt = 1; attempt <= WRITE_RETRY_ATTEMPTS; attempt++) {
		try {
			await api.patch(`/projects/${projectId}/tasks/${taskId}`, payload);
			const persisted = await resolveTaskByIdentifier(api, projectId, taskId);
			if (verify(persisted)) return attempt;
			lastError = new Error(`Verification failed after write (attempt ${attempt}/${WRITE_RETRY_ATTEMPTS}).`);
		} catch (error) {
			lastError = error;
		}

		if (attempt < WRITE_RETRY_ATTEMPTS) await delay(WRITE_RETRY_BACKOFF_MS * attempt);
	}

	if (lastError instanceof Error) throw lastError;
	throw new Error('Task write failed after retries.');
}

function buildMcpPayload(options: {
	toolName: string;
	operationId: string;
	payloadHash: string;
	agent: string;
	model: string;
	chatContext: ResolvedChatContext;
	tokenSource: TokenSource;
	tokens: TokenTotals;
	latencyMs?: number;
	changedFields: string[];
	requestHeaders?: unknown;
}): { mcpContext: Record<string, unknown>; mcpEvent: Record<string, unknown> } {
	const requestId = pickHeaderValue(options.requestHeaders, ['x-request-id']);
	return {
		mcpContext: {
			actor: options.agent,
			tool: options.toolName,
			last_chat_id: options.chatContext.chatId,
			last_chat_name: options.chatContext.chatName,
			last_session_id: options.chatContext.sessionId,
			last_seen_at: new Date().toISOString()
		},
		mcpEvent: {
			tool: options.toolName,
			operation_id: options.operationId,
			payload_hash: options.payloadHash,
			agent: options.agent,
			model: options.model,
			token_source: options.tokenSource,
			tokens: options.tokens,
			latency_ms: options.latencyMs ?? 0,
			changed_fields: options.changedFields,
			request_id: requestId
		}
	};
}

/**
 * Task write tools
 */
export function registerTaskWriteTools(server: McpServer): void {
	server.tool(
		'update_task_plan',
		'Use when the user asks to define or revise an implementation plan for a task before coding.',
		{
			taskId: TaskIdentifierSchema.describe('Task ID (full UUID or truncated prefix)'),
			operation_id: OperationIdSchema.describe('Client-generated idempotency key for this write'),
			plan: PlanSchema,
			mode: ArtifactModeSchema.optional().describe('Optional artifact mode: "mini" fallback or "full" when a complete plan already exists.'),
			model: z.string().trim().min(1).max(120).describe('Model used for this plan (e.g. "claude-sonnet-4-20250514")'),
			agent: z.string().trim().min(1).max(80).describe('Agent/client name (e.g. "cursor", "claude-desktop")'),
			tokens: TokensSchema.optional().describe('Optional token usage for this write operation'),
			chat_id: z.string().trim().min(1).max(120).optional().describe('Optional chat/thread identifier'),
			chat_name: z.string().trim().min(1).max(160).optional().describe('Optional chat/thread display name')
		},
		{ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		async ({ taskId, operation_id, plan, mode, model, agent, tokens, chat_id, chat_name }, extra) => {
			const startedAt = Date.now();
			try {
				const parsed = PlanSchema.parse(plan);
				const planContent = renderPlanMarkdown(parsed);
				const artifactMode = mode ?? 'mini';
				const resolvedTokens = resolveTokens(planContent, tokens);
				const payloadHash = stableHash({ plan: parsed, mode: artifactMode });

				const config = requireProject();
				const projectId = config.currentProjectId;
				if (!projectId) throw new Error('NO_ACTIVE_PROJECT: No project selected.');

				const api = getApiClient();
				const currentTask = await resolveTaskByIdentifier(api, projectId, taskId);
				const chatContext = resolveChatContext({
					chatId: chat_id,
					chatName: chat_name,
					sessionId: extra.sessionId,
					requestHeaders: extra.requestInfo?.headers
				});
				const mcpPayload = buildMcpPayload({
					toolName: 'update_task_plan',
					operationId: operation_id,
					payloadHash,
					agent,
					model,
					chatContext,
					tokenSource: resolvedTokens.tokenSource,
					tokens: resolvedTokens.tokens,
					latencyMs: Date.now() - startedAt,
					changedFields: ['plan'],
					requestHeaders: extra.requestInfo?.headers
				});

				const attemptsUsed = await patchTaskWithRetryAndVerification(
					api,
					projectId,
					currentTask.id,
					{ plan: planContent, ...mcpPayload },
					(persistedTask) => typeof persistedTask.plan === 'string' && persistedTask.plan.trim() === planContent
				);

				await syncChatTaskBindingHeartbeatFromWrite({
					projectId,
					taskId: currentTask.id,
					status: currentTask.status,
					lastTool: 'update_task_plan',
					chatId: chat_id,
					requestHeaders: extra.requestInfo?.headers
				});

				trackToolCall({
					tool: 'update_task_plan',
					input: { taskId, operation_id, mode: artifactMode },
					output: { steps: parsed.steps.length, files: parsed.files_affected.length },
					latencyMs: Date.now() - startedAt,
					retries: Math.max(0, attemptsUsed - 1),
					sessionId: chatContext.sessionId,
					chatId: chatContext.chatId,
					chatName: chatContext.chatName,
					prompt: extractPromptFromHeaders(extra.requestInfo?.headers)
				});

				return {
					content: [
						{
							type: 'text' as const,
							text: `✔ Plan updated for task \`${currentTask.id.substring(0, 5)}\`.\n\n**Mode**: ${artifactMode}\n**Steps**: ${parsed.steps.length}\n**Files affected**: ${parsed.files_affected.length}\n**Complexity**: ${parsed.estimated_complexity || 'not specified'}`
						}
					]
				};
			} catch (error) {
				trackToolCall({
					tool: 'update_task_plan',
					input: { taskId, operation_id },
					error: error instanceof Error ? error.message : String(error),
					latencyMs: Date.now() - startedAt,
					prompt: extractPromptFromHeaders(extra.requestInfo?.headers)
				});
				if (error instanceof z.ZodError) {
					const issues = error.issues.map((i) => `- ${i.path.join('.')}: ${i.message}`).join('\n');
					return { content: [{ type: 'text' as const, text: `INVALID_INPUT: Plan validation failed:\n${issues}` }], isError: true };
				}
				const err = formatApiError(error);
				return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
			}
		}
	);

	server.tool(
		'update_task_walkthrough',
		'Use when the user asks to capture what was implemented, validated, and decided after execution.',
		{
			taskId: TaskIdentifierSchema.describe('Task ID (full UUID or truncated prefix)'),
			operation_id: OperationIdSchema.describe('Client-generated idempotency key for this write'),
			walkthrough: WalkthroughSchema,
			mode: ArtifactModeSchema.optional().describe('Optional artifact mode: "mini" fallback or "full" when a complete walkthrough already exists.'),
			model: z.string().trim().min(1).max(120).describe('Model used for this walkthrough'),
			agent: z.string().trim().min(1).max(80).describe('Agent/client name'),
			tokens: TokensSchema.optional().describe('Optional token usage for this write operation'),
			chat_id: z.string().trim().min(1).max(120).optional().describe('Optional chat/thread identifier'),
			chat_name: z.string().trim().min(1).max(160).optional().describe('Optional chat/thread display name')
		},
		{ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		async ({ taskId, operation_id, walkthrough, mode, model, agent, tokens, chat_id, chat_name }, extra) => {
			const startedAt = Date.now();
			try {
				const parsed = WalkthroughSchema.parse(walkthrough);
				const walkthroughContent = renderWalkthroughMarkdown(parsed);
				const artifactMode = mode ?? 'mini';
				const resolvedTokens = resolveTokens(walkthroughContent, tokens);
				const payloadHash = stableHash({ walkthrough: parsed, mode: artifactMode });

				const config = requireProject();
				const projectId = config.currentProjectId;
				if (!projectId) throw new Error('NO_ACTIVE_PROJECT: No project selected.');

				const api = getApiClient();
				const currentTask = await resolveTaskByIdentifier(api, projectId, taskId);
				const chatContext = resolveChatContext({
					chatId: chat_id,
					chatName: chat_name,
					sessionId: extra.sessionId,
					requestHeaders: extra.requestInfo?.headers
				});
				const mcpPayload = buildMcpPayload({
					toolName: 'update_task_walkthrough',
					operationId: operation_id,
					payloadHash,
					agent,
					model,
					chatContext,
					tokenSource: resolvedTokens.tokenSource,
					tokens: resolvedTokens.tokens,
					latencyMs: Date.now() - startedAt,
					changedFields: ['status', 'walkthrough'],
					requestHeaders: extra.requestInfo?.headers
				});

				const attemptsUsed = await patchTaskWithRetryAndVerification(
					api,
					projectId,
					currentTask.id,
					{ status: 'in_review', walkthrough: walkthroughContent, ...mcpPayload },
					(persistedTask) =>
						typeof persistedTask.walkthrough === 'string' &&
						persistedTask.walkthrough.trim() === walkthroughContent &&
						persistedTask.status === 'in_review'
				);

				await syncChatTaskBindingHeartbeatFromWrite({
					projectId,
					taskId: currentTask.id,
					status: 'in_review',
					lastTool: 'update_task_walkthrough',
					chatId: chat_id,
					requestHeaders: extra.requestInfo?.headers
				});

				trackToolCall({
					tool: 'update_task_walkthrough',
					input: { taskId, operation_id, mode: artifactMode },
					output: { changes: parsed.changes.length, files: parsed.files_modified.length },
					latencyMs: Date.now() - startedAt,
					retries: Math.max(0, attemptsUsed - 1),
					sessionId: chatContext.sessionId,
					chatId: chatContext.chatId,
					chatName: chatContext.chatName,
					prompt: extractPromptFromHeaders(extra.requestInfo?.headers)
				});

				return {
					content: [
						{
							type: 'text' as const,
							text: `✔ Walkthrough updated for task \`${currentTask.id.substring(0, 5)}\`.\n\n**Mode**: ${artifactMode}\n**Changes**: ${parsed.changes.length}\n**Files modified**: ${parsed.files_modified.length}\n**Status**: in_review`
						}
					]
				};
			} catch (error) {
				trackToolCall({
					tool: 'update_task_walkthrough',
					input: { taskId, operation_id },
					error: error instanceof Error ? error.message : String(error),
					latencyMs: Date.now() - startedAt,
					prompt: extractPromptFromHeaders(extra.requestInfo?.headers)
				});
				if (error instanceof z.ZodError) {
					const issues = error.issues.map((i) => `- ${i.path.join('.')}: ${i.message}`).join('\n');
					return { content: [{ type: 'text' as const, text: `INVALID_INPUT: Walkthrough validation failed:\n${issues}` }], isError: true };
				}
				const err = formatApiError(error);
				return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
			}
		}
	);

	server.tool(
		'set_task_status',
		'Use when the user explicitly asks to move a task to a lifecycle status (except done).',
		{
			taskId: TaskIdentifierSchema.describe('Task ID (full UUID or truncated prefix)'),
			status: TaskStatusSchema.describe('New status: todo, in_progress, in_review, backlog, frozen'),
			operation_id: OperationIdSchema.describe('Client-generated idempotency key for this write'),
			model: z.string().trim().min(1).max(120).describe('Model used (for execution metadata tracking)'),
			agent: z.string().trim().min(1).max(80).describe('Agent/client name'),
			tokens: TokensSchema.optional().describe('Optional token usage for this write operation'),
			chat_id: z.string().trim().min(1).max(120).optional().describe('Optional chat/thread identifier'),
			chat_name: z.string().trim().min(1).max(160).optional().describe('Optional chat/thread display name')
		},
		{ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		async ({ taskId, status, operation_id, model, agent, tokens, chat_id, chat_name }, extra) => {
			const startedAt = Date.now();
			try {
				const config = requireProject();
				const projectId = config.currentProjectId;
				if (!projectId) throw new Error('NO_ACTIVE_PROJECT: No project selected.');
				const api = getApiClient();
				const currentTask = await resolveTaskByIdentifier(api, projectId, taskId);
				const chatContext = resolveChatContext({
					chatId: chat_id,
					chatName: chat_name,
					sessionId: extra.sessionId,
					requestHeaders: extra.requestInfo?.headers
				});
				const resolvedTokens = resolveTokens(JSON.stringify({ status }), tokens);
				const payloadHash = stableHash({ status });
				const mcpPayload = buildMcpPayload({
					toolName: 'set_task_status',
					operationId: operation_id,
					payloadHash,
					agent,
					model,
					chatContext,
					tokenSource: resolvedTokens.tokenSource,
					tokens: resolvedTokens.tokens,
					latencyMs: Date.now() - startedAt,
					changedFields: ['status'],
					requestHeaders: extra.requestInfo?.headers
				});

				const attemptsUsed = await patchTaskWithRetryAndVerification(
					api,
					projectId,
					currentTask.id,
					{ status, ...mcpPayload },
					(persistedTask) => persistedTask.status === status
				);

				await syncChatTaskBindingHeartbeatFromWrite({
					projectId,
					taskId: currentTask.id,
					status,
					lastTool: 'set_task_status',
					chatId: chat_id,
					requestHeaders: extra.requestInfo?.headers
				});

				trackToolCall({
					tool: 'set_task_status',
					input: { taskId, status, operation_id },
					output: { status },
					latencyMs: Date.now() - startedAt,
					retries: Math.max(0, attemptsUsed - 1),
					sessionId: chatContext.sessionId,
					chatId: chatContext.chatId,
					chatName: chatContext.chatName,
					prompt: extractPromptFromHeaders(extra.requestInfo?.headers)
				});

				return {
					content: [{ type: 'text' as const, text: `✔ Task \`${currentTask.id.substring(0, 5)}\` status set to \`${status}\`.` }]
				};
			} catch (error) {
				trackToolCall({
					tool: 'set_task_status',
					input: { taskId, status, operation_id },
					error: error instanceof Error ? error.message : String(error),
					latencyMs: Date.now() - startedAt,
					prompt: extractPromptFromHeaders(extra.requestInfo?.headers)
				});
				const err = formatApiError(error);
				return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
			}
		}
	);

	server.tool(
		'set_task_priority',
		'Use when the user explicitly asks to change urgency or priority of an existing task.',
		{
			taskId: TaskIdentifierSchema.describe('Task ID (full UUID or truncated prefix)'),
			priority: TaskPrioritySchema.describe('New priority: low, medium, high, urgent'),
			operation_id: OperationIdSchema.describe('Client-generated idempotency key for this write'),
			model: z.string().trim().min(1).max(120).describe('Model used (for execution metadata tracking)'),
			agent: z.string().trim().min(1).max(80).describe('Agent/client name'),
			tokens: TokensSchema.optional().describe('Optional token usage for this write operation'),
			chat_id: z.string().trim().min(1).max(120).optional().describe('Optional chat/thread identifier'),
			chat_name: z.string().trim().min(1).max(160).optional().describe('Optional chat/thread display name')
		},
		{ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		async ({ taskId, priority, operation_id, model, agent, tokens, chat_id, chat_name }, extra) => {
			const startedAt = Date.now();
			try {
				const config = requireProject();
				const projectId = config.currentProjectId;
				if (!projectId) throw new Error('NO_ACTIVE_PROJECT: No project selected.');
				const api = getApiClient();
				const currentTask = await resolveTaskByIdentifier(api, projectId, taskId);
				const chatContext = resolveChatContext({
					chatId: chat_id,
					chatName: chat_name,
					sessionId: extra.sessionId,
					requestHeaders: extra.requestInfo?.headers
				});
				const resolvedTokens = resolveTokens(JSON.stringify({ priority }), tokens);
				const payloadHash = stableHash({ priority });
				const mcpPayload = buildMcpPayload({
					toolName: 'set_task_priority',
					operationId: operation_id,
					payloadHash,
					agent,
					model,
					chatContext,
					tokenSource: resolvedTokens.tokenSource,
					tokens: resolvedTokens.tokens,
					latencyMs: Date.now() - startedAt,
					changedFields: ['priority'],
					requestHeaders: extra.requestInfo?.headers
				});

				const attemptsUsed = await patchTaskWithRetryAndVerification(
					api,
					projectId,
					currentTask.id,
					{ priority, ...mcpPayload },
					(persistedTask) => persistedTask.priority === priority
				);

				await syncChatTaskBindingHeartbeatFromWrite({
					projectId,
					taskId: currentTask.id,
					status: currentTask.status,
					lastTool: 'set_task_priority',
					chatId: chat_id,
					requestHeaders: extra.requestInfo?.headers
				});

				trackToolCall({
					tool: 'set_task_priority',
					input: { taskId, priority, operation_id },
					output: { priority },
					latencyMs: Date.now() - startedAt,
					retries: Math.max(0, attemptsUsed - 1),
					sessionId: chatContext.sessionId,
					chatId: chatContext.chatId,
					chatName: chatContext.chatName,
					prompt: extractPromptFromHeaders(extra.requestInfo?.headers)
				});

				return {
					content: [{ type: 'text' as const, text: `✔ Task \`${currentTask.id.substring(0, 5)}\` priority set to \`${priority}\`.` }]
				};
			} catch (error) {
				trackToolCall({
					tool: 'set_task_priority',
					input: { taskId, priority, operation_id },
					error: error instanceof Error ? error.message : String(error),
					latencyMs: Date.now() - startedAt,
					prompt: extractPromptFromHeaders(extra.requestInfo?.headers)
				});
				const err = formatApiError(error);
				return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
			}
		}
	);
}

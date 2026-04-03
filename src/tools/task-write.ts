import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AxiosInstance } from 'axios';
import { randomUUID } from 'node:crypto';
import { requireProject } from '../config.js';
import { getApiClient, formatApiError } from '../api.js';
import {
	ArtifactModeSchema,
	OperationIdSchema,
	PlanSchema,
	TaskIdentifierSchema,
	TaskStatusSchema,
	TokensSchema,
	WalkthroughSchema
} from '../schemas.js';
import { resolveTaskByIdentifier } from './task-common.js';
import { extractPromptFromHeaders, stableHash, trackToolCall } from '../observability.js';
import { getGitMetadata, resolveAffectedRepos } from '../git.js';
import { consumeConfirmationToken, isSensitiveConfirmationEnabled, issueConfirmationToken } from '../confirmation.js';
import { bindingTracker } from '../lifecycle/index.js';

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
const DEFAULT_AGENT = 'mcp-client';
const DEFAULT_MODEL = 'unknown';

interface GitContext {
	branch: string | null;
	commitHash: string | null;
	remoteUrl: string | null;
	status: string;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build a lifecycle state info string for tool responses.
 * Shows the current lifecycle step and what remains.
 */
function buildLifecycleInfoResponse(taskId: string): string {
	const state = bindingTracker.getState(taskId);
	if (!state) return '';

	const lines: string[] = ['', '', '---'];
	lines.push('**Lifecycle State:**');

	if (state.boundAt) {
		lines.push(`- [x] Task bound`);
	} else {
		lines.push(`- [ ] Task bound`);
	}

	if (state.planWrittenAt) {
		lines.push(`- [x] Plan written`);
	} else {
		lines.push(`- [ ] Plan written`);
	}

	if (state.inProgressAt) {
		lines.push(`- [x] In progress`);
	} else {
		lines.push(`- [ ] In progress`);
	}

	if (state.walkthroughWrittenAt) {
		lines.push(`- [x] Walkthrough written`);
	} else {
		lines.push(`- [ ] Walkthrough written`);
	}

	if (state.inReviewAt) {
		lines.push(`- [x] In review`);
	} else {
		lines.push(`- [ ] In review`);
	}

	// Add warning if lifecycle is not complete
	const nextStep = bindingTracker.getNextRequiredStep(taskId);
	if (nextStep) {
		lines.push('');
		lines.push(`> ⚠️ **Lifecycle incomplete**: Next step required is \`${nextStep}\`.`);
	}

	return lines.join('\n');
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
	sessionId: string;
}

interface ConfirmationMeta {
	tokenId: string;
	confirmedAt: string;
	requestedAt: string;
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

	// Pre-process headers to be lower-case for easier lookup
	const lowerHeaders: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(headers)) {
		lowerHeaders[key.toLowerCase()] = value;
	}

	for (const key of keys) {
		const lowerKey = key.toLowerCase();
		const value = lowerHeaders[lowerKey];
		if (typeof value === 'string' && value.trim().length > 0) return value.trim();
		if (Array.isArray(value)) {
			const first = value.find((v) => typeof v === 'string' && v.trim().length > 0);
			if (typeof first === 'string') return first.trim();
		}
	}
	return undefined;
}

function resolveChatContext(options: { chatId?: string; taskId: string; requestHeaders?: unknown }): ResolvedChatContext {
	const headerChatId = pickHeaderValue(options.requestHeaders, ['x-chat-id']);
	const headerSessionId = pickHeaderValue(options.requestHeaders, ['x-session-id']);
	const chatId = pickString(options.chatId) ?? headerChatId ?? headerSessionId ?? 'session:unknown';
	const sessionId = `${chatId}_${options.taskId}`;

	return { chatId, sessionId };
}

function resolveAgentName(options: { agent?: string; requestHeaders?: unknown }): string {
	return pickString(options.agent) ?? pickHeaderValue(options.requestHeaders, ['x-agent']) ?? DEFAULT_AGENT;
}

function resolveModelName(options: { model?: string; requestHeaders?: unknown }): string {
	return pickString(options.model) ?? pickHeaderValue(options.requestHeaders, ['x-model']) ?? DEFAULT_MODEL;
}

function resolveOperationId(options: { operationId?: string; toolName: string }): string {
	const provided = pickString(options.operationId);
	if (provided) return provided;
	return `auto:${options.toolName}:${Date.now()}:${randomUUID().slice(0, 8)}`;
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

function resolveExecutionMode(mode: 'preview' | 'execute' | undefined): 'preview' | 'execute' {
	if (mode) return mode;
	return isSensitiveConfirmationEnabled() ? 'preview' : 'execute';
}

function resolveIdempotencyErrorCode(error: unknown): 'idempotency_conflict' | 'other' {
	const message = error instanceof Error ? error.message : String(error);
	if (message.includes('IDEMPOTENCY_CONFLICT')) return 'idempotency_conflict';
	return 'other';
}

function resolvePlanLifecycleStatus(currentStatus: string): string {
	if (currentStatus === 'todo' || currentStatus === 'backlog') return 'in_progress';
	return currentStatus;
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
	confirmation?: ConfirmationMeta;
	gitContext?: GitContext;
	gitContexts?: GitContext[];
	affectedFiles?: string[];
}): { mcpContext: Record<string, unknown>; mcpEvent: Record<string, unknown> } {
	// If multi-repo contexts are provided, use them
	// Otherwise fall back to single gitContext for backward compatibility
	const contexts = options.gitContexts ?? (options.gitContext ? [options.gitContext] : []);
	
	// Build the primary git fields from the first context (for backward compatibility)
	const primaryContext = contexts[0];
	
	return {
		mcpContext: {
			actor: options.agent,
			tool: options.toolName,
			chat_id: options.chatContext.chatId,
			session_id: options.chatContext.sessionId,
			last_seen_at: new Date().toISOString(),
			last_model: options.model,
			// Primary repo fields (backward compatibility)
			git_branch: primaryContext?.branch ?? undefined,
			git_commit_hash: primaryContext?.commitHash ?? undefined,
			git_remote_url: primaryContext?.remoteUrl ?? undefined,
			git_status: primaryContext?.status ?? undefined,
			// Multi-repo support
			git_contexts: contexts.length > 0 ? contexts.map(ctx => ({
				branch: ctx.branch,
				commit_hash: ctx.commitHash,
				remote_url: ctx.remoteUrl,
				status: ctx.status,
				repo_name: ctx.repoName,
				repo_path: ctx.repoPath
			})) : undefined,
			affected_files: options.affectedFiles
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
			confirmation_id: options.confirmation?.tokenId,
			confirmation_confirmed_at: options.confirmation?.confirmedAt,
			confirmation_requested_at: options.confirmation?.requestedAt
		}
	};
}

/**
 * Task write tools
 */
export function registerTaskWriteTools(server: McpServer): void {
	server.tool(
		'update_task_plan',
		'Persist or revise an implementation plan for a task before/during execution.',
		{
			taskId: TaskIdentifierSchema.describe('Task ID (full UUID or truncated prefix)'),
			operation_id: OperationIdSchema.optional().describe('Optional idempotency key. Auto-generated when omitted.'),
			plan: PlanSchema,
			mode: ArtifactModeSchema.optional().describe(
				'Optional artifact mode: "mini" fallback or "full" when a complete plan already exists.'
			),
			model: z
				.string()
				.trim()
				.min(1)
				.max(120)
				.describe(
					'Model name used for this plan (e.g. "claude-sonnet-4-20250514", "gemini-2.5-pro"). You MUST provide the actual model identifier.'
				),
			agent: z
				.string()
				.trim()
				.min(1)
				.max(80)
				.describe(
					'Agent/client name (e.g. "claude-code", "cursor", "antigravity"). You MUST provide the actual client name.'
				),
			tokens: TokensSchema.optional().describe(
				'Optional cumulative token usage for this entire chat session up to this point'
			),
			execution_mode: z
				.enum(['preview', 'execute'])
				.optional()
				.describe('Confirmation mode: preview issues confirmation token, execute performs write'),
			confirmation_token: z
				.string()
				.trim()
				.min(8)
				.max(200)
				.optional()
				.describe('Token returned by preview mode for sensitive writes'),
			chat_id: z
				.string()
				.trim()
				.min(1)
				.max(120)
				.describe('Chat/thread identifier. You MUST provide the current chat or conversation ID.')
		},
		{ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		async (
			{ taskId, operation_id, plan, mode, model, agent, tokens, execution_mode, confirmation_token, chat_id },
			extra
		) => {
			const startedAt = Date.now();
			try {
				const parsed = PlanSchema.parse(plan);
				const planContent = renderPlanMarkdown(parsed);
				const artifactMode = mode ?? 'mini';
				const resolvedTokens = resolveTokens(planContent, tokens);
				const payloadHash = stableHash({ plan: parsed, mode: artifactMode });
				const resolvedOperationId = resolveOperationId({ operationId: operation_id, toolName: 'update_task_plan' });
				const resolvedAgent = resolveAgentName({ agent, requestHeaders: extra.requestInfo?.headers });
				const resolvedModel = resolveModelName({ model, requestHeaders: extra.requestInfo?.headers });

				const config = requireProject();
				const projectId = config.currentProjectId;
				if (!projectId) throw new Error('NO_ACTIVE_PROJECT: No project selected.');

				const api = getApiClient();
				const currentTask = await resolveTaskByIdentifier(api, projectId, taskId);
				const targetStatus = resolvePlanLifecycleStatus(currentTask.status);
				const shouldMoveToInProgress = targetStatus !== currentTask.status;
				const resolvedExecutionMode = resolveExecutionMode(execution_mode);
				const confirmationScope = `task:${projectId}:${currentTask.id}`;
				const chatContext = resolveChatContext({
					chatId: chat_id,
					taskId: currentTask.id,
					requestHeaders: extra.requestInfo?.headers
				});
				if (resolvedExecutionMode === 'preview') {
					const confirmation = issueConfirmationToken({
						tool: 'update_task_plan',
						payloadHash,
						scope: confirmationScope,
						actor: resolvedAgent
					});
					return {
						content: [
							{
								type: 'text' as const,
								text: [
									`## update_task_plan · preview`,
									`- task_id: ${currentTask.id}`,
									`- operation_id: ${resolvedOperationId}`,
									`- plan_steps: ${parsed.steps.length}`,
									`- files_affected: ${parsed.files_affected.length}`,
									`- target_status: ${targetStatus}`,
									`- payload_hash: ${payloadHash}`,
									`- confirmation_token: ${confirmation.token}`,
									`- confirmation_expires_at: ${confirmation.expiresAt}`,
									`- result_code: preview_ready`
								].join('\n')
							}
						]
					};
				}

				let confirmationMeta: ConfirmationMeta | undefined;
				if (isSensitiveConfirmationEnabled()) {
					if (!confirmation_token) {
						return {
							content: [
								{
									type: 'text' as const,
									text: 'CONFIRMATION_REQUIRED: call mode="preview" first, then execute with confirmation_token.'
								}
							],
							isError: true
						};
					}
					confirmationMeta = consumeConfirmationToken({
						token: confirmation_token,
						tool: 'update_task_plan',
						payloadHash,
						scope: confirmationScope,
						actor: resolvedAgent
					});
				}

				const gitContext = getGitMetadata();
				// Multi-repo detection: use files_affected from plan if available
				const affectedFiles = parsed.files_affected ?? [];
				const gitContexts = affectedFiles.length > 0
					? resolveAffectedRepos(affectedFiles)
					: [gitContext];
				const mcpPayload = buildMcpPayload({
					toolName: 'update_task_plan',
					operationId: resolvedOperationId,
					payloadHash,
					agent: resolvedAgent,
					model: resolvedModel,
					chatContext,
					tokenSource: resolvedTokens.tokenSource,
					tokens: resolvedTokens.tokens,
					latencyMs: Date.now() - startedAt,
					changedFields: shouldMoveToInProgress ? ['plan', 'status'] : ['plan'],
					requestHeaders: extra.requestInfo?.headers,
					confirmation: confirmationMeta,
					gitContext,
					gitContexts,
					affectedFiles
				});

				const attemptsUsed = await patchTaskWithRetryAndVerification(
					api,
					projectId,
					currentTask.id,
					{ plan: planContent, status: targetStatus, ...mcpPayload },
					(persistedTask) =>
						typeof persistedTask.plan === 'string' &&
						persistedTask.plan.trim() === planContent &&
						persistedTask.status === targetStatus
				);

				trackToolCall({
					tool: 'update_task_plan',
					input: { taskId, operation_id: resolvedOperationId, mode: artifactMode },
					output: { steps: parsed.steps.length, files: parsed.files_affected.length },
					latencyMs: Date.now() - startedAt,
					retries: Math.max(0, attemptsUsed - 1),
					chatId: chatContext.chatId,
					prompt: extractPromptFromHeaders(extra.requestInfo?.headers)
				});

				// Lifecycle tracking: mark plan as written for bound tasks
				if (bindingTracker.isBound(currentTask.id)) {
					bindingTracker.markPlanWritten(currentTask.id);
					if (shouldMoveToInProgress) {
						bindingTracker.markInProgress(currentTask.id);
					}
				}

				// Build lifecycle state for response
				const lifecycleInfo = buildLifecycleInfoResponse(currentTask.id);

				return {
					content: [
						{
							type: 'text' as const,
							text: `✔ Plan updated for task \`${currentTask.id.substring(0, 5)}\`.\n\n**Mode**: ${artifactMode}\n**Steps**: ${parsed.steps.length}\n**Files affected**: ${parsed.files_affected.length}\n**Status**: ${targetStatus}\n**Complexity**: ${parsed.estimated_complexity || 'not specified'}\n**Operation ID**: ${resolvedOperationId}\n**result_code**: applied${lifecycleInfo}`
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
					return {
						content: [{ type: 'text' as const, text: `INVALID_INPUT: Plan validation failed:\n${issues}` }],
						isError: true
					};
				}
				const err = formatApiError(error);
				if (resolveIdempotencyErrorCode(error) === 'idempotency_conflict') {
					return {
						content: [{ type: 'text' as const, text: `Error: ${err.message}\nresult_code: idempotency_conflict` }],
						isError: true
					};
				}
				return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
			}
		}
	);

	server.tool(
		'update_task_walkthrough',
		'Persist a post-execution walkthrough and move the task lifecycle to in_review.',
		{
			taskId: TaskIdentifierSchema.describe('Task ID (full UUID or truncated prefix)'),
			operation_id: OperationIdSchema.optional().describe('Optional idempotency key. Auto-generated when omitted.'),
			walkthrough: WalkthroughSchema,
			mode: ArtifactModeSchema.optional().describe(
				'Optional artifact mode: "mini" fallback or "full" when a complete walkthrough already exists.'
			),
			model: z
				.string()
				.trim()
				.min(1)
				.max(120)
				.describe(
					'Model name used for this walkthrough (e.g. "claude-sonnet-4-20250514", "gemini-2.5-pro"). You MUST provide the actual model identifier.'
				),
			agent: z
				.string()
				.trim()
				.min(1)
				.max(80)
				.describe(
					'Agent/client name (e.g. "claude-code", "cursor", "antigravity"). You MUST provide the actual client name.'
				),
			tokens: TokensSchema.optional().describe(
				'Optional cumulative token usage for this entire chat session up to this point'
			),
			execution_mode: z
				.enum(['preview', 'execute'])
				.optional()
				.describe('Confirmation mode: preview issues confirmation token, execute performs write'),
			confirmation_token: z
				.string()
				.trim()
				.min(8)
				.max(200)
				.optional()
				.describe('Token returned by preview mode for sensitive writes'),
			chat_id: z
				.string()
				.trim()
				.min(1)
				.max(120)
				.describe('Chat/thread identifier. You MUST provide the current chat or conversation ID.')
		},
		{ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		async (
			{ taskId, operation_id, walkthrough, mode, model, agent, tokens, execution_mode, confirmation_token, chat_id },
			extra
		) => {
			const startedAt = Date.now();
			try {
				const parsed = WalkthroughSchema.parse(walkthrough);
				const walkthroughContent = renderWalkthroughMarkdown(parsed);
				const artifactMode = mode ?? 'mini';
				const resolvedTokens = resolveTokens(walkthroughContent, tokens);
				const payloadHash = stableHash({ walkthrough: parsed, mode: artifactMode });
				const resolvedOperationId = resolveOperationId({
					operationId: operation_id,
					toolName: 'update_task_walkthrough'
				});
				const resolvedAgent = resolveAgentName({ agent, requestHeaders: extra.requestInfo?.headers });
				const resolvedModel = resolveModelName({ model, requestHeaders: extra.requestInfo?.headers });

				const config = requireProject();
				const projectId = config.currentProjectId;
				if (!projectId) throw new Error('NO_ACTIVE_PROJECT: No project selected.');

				const api = getApiClient();
				const currentTask = await resolveTaskByIdentifier(api, projectId, taskId);
				const resolvedExecutionMode = resolveExecutionMode(execution_mode);
				const confirmationScope = `task:${projectId}:${currentTask.id}`;
				const chatContext = resolveChatContext({
					chatId: chat_id,
					taskId: currentTask.id,
					requestHeaders: extra.requestInfo?.headers
				});
				if (resolvedExecutionMode === 'preview') {
					const confirmation = issueConfirmationToken({
						tool: 'update_task_walkthrough',
						payloadHash,
						scope: confirmationScope,
						actor: resolvedAgent
					});
					return {
						content: [
							{
								type: 'text' as const,
								text: [
									`## update_task_walkthrough · preview`,
									`- task_id: ${currentTask.id}`,
									`- operation_id: ${resolvedOperationId}`,
									`- changes: ${parsed.changes.length}`,
									`- files_modified: ${parsed.files_modified.length}`,
									`- target_status: in_review`,
									`- payload_hash: ${payloadHash}`,
									`- confirmation_token: ${confirmation.token}`,
									`- confirmation_expires_at: ${confirmation.expiresAt}`,
									`- result_code: preview_ready`
								].join('\n')
							}
						]
					};
				}

				let confirmationMeta: ConfirmationMeta | undefined;
				if (isSensitiveConfirmationEnabled()) {
					if (!confirmation_token) {
						return {
							content: [
								{
									type: 'text' as const,
									text: 'CONFIRMATION_REQUIRED: call mode="preview" first, then execute with confirmation_token.'
								}
							],
							isError: true
						};
					}
					confirmationMeta = consumeConfirmationToken({
						token: confirmation_token,
						tool: 'update_task_walkthrough',
						payloadHash,
						scope: confirmationScope,
						actor: resolvedAgent
					});
				}

				const gitContext = getGitMetadata();
				// Multi-repo detection: use files_modified from walkthrough
				const affectedFiles = parsed.files_modified ?? [];
				const gitContexts = affectedFiles.length > 0
					? resolveAffectedRepos(affectedFiles)
					: [gitContext];
				const mcpPayload = buildMcpPayload({
					toolName: 'update_task_walkthrough',
					operationId: resolvedOperationId,
					payloadHash,
					agent: resolvedAgent,
					model: resolvedModel,
					chatContext,
					tokenSource: resolvedTokens.tokenSource,
					tokens: resolvedTokens.tokens,
					latencyMs: Date.now() - startedAt,
					changedFields: ['status', 'walkthrough'],
					requestHeaders: extra.requestInfo?.headers,
					confirmation: confirmationMeta,
					gitContext,
					gitContexts,
					affectedFiles
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

				trackToolCall({
					tool: 'update_task_walkthrough',
					input: { taskId, operation_id: resolvedOperationId, mode: artifactMode },
					output: { changes: parsed.changes.length, files: parsed.files_modified.length },
					latencyMs: Date.now() - startedAt,
					retries: Math.max(0, attemptsUsed - 1),
					chatId: chatContext.chatId,
					prompt: extractPromptFromHeaders(extra.requestInfo?.headers)
				});

				// Lifecycle tracking: mark walkthrough as written for bound tasks
				if (bindingTracker.isBound(currentTask.id)) {
					bindingTracker.markWalkthroughWritten(currentTask.id);
					bindingTracker.markInReview(currentTask.id);
				}

				// Build lifecycle state for response
				const lifecycleInfo = buildLifecycleInfoResponse(currentTask.id);

				return {
					content: [
						{
							type: 'text' as const,
							text: `✔ Walkthrough updated for task \`${currentTask.id.substring(0, 5)}\`.\n\n**Mode**: ${artifactMode}\n**Changes**: ${parsed.changes.length}\n**Files modified**: ${parsed.files_modified.length}\n**Status**: in_review\n**Operation ID**: ${resolvedOperationId}\n**result_code**: applied${lifecycleInfo}`
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
					return {
						content: [{ type: 'text' as const, text: `INVALID_INPUT: Walkthrough validation failed:\n${issues}` }],
						isError: true
					};
				}
				const err = formatApiError(error);
				if (resolveIdempotencyErrorCode(error) === 'idempotency_conflict') {
					return {
						content: [{ type: 'text' as const, text: `Error: ${err.message}\nresult_code: idempotency_conflict` }],
						isError: true
					};
				}
				return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
			}
		}
	);

	server.tool(
		'set_task_status',
		'Set task lifecycle status during execution flow (except done).',
		{
			taskId: TaskIdentifierSchema.describe('Task ID (full UUID or truncated prefix)'),
			status: TaskStatusSchema.describe('New status: todo, in_progress, in_review, backlog, frozen'),
			operation_id: OperationIdSchema.optional().describe('Optional idempotency key. Auto-generated when omitted.'),
			model: z
				.string()
				.trim()
				.min(1)
				.max(120)
				.describe(
					'Model name used (e.g. "claude-sonnet-4-20250514", "gemini-2.5-pro"). You MUST provide the actual model identifier.'
				),
			agent: z
				.string()
				.trim()
				.min(1)
				.max(80)
				.describe(
					'Agent/client name (e.g. "claude-code", "cursor", "antigravity"). You MUST provide the actual client name.'
				),
			tokens: TokensSchema.optional().describe(
				'Optional cumulative token usage for this entire chat session up to this point'
			),
			execution_mode: z
				.enum(['preview', 'execute'])
				.optional()
				.describe('Confirmation mode: preview issues confirmation token, execute performs write'),
			confirmation_token: z
				.string()
				.trim()
				.min(8)
				.max(200)
				.optional()
				.describe('Token returned by preview mode for sensitive writes'),
			chat_id: z
				.string()
				.trim()
				.min(1)
				.max(120)
				.describe('Chat/thread identifier. You MUST provide the current chat or conversation ID.')
		},
		{ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		async (
			{ taskId, status, operation_id, model, agent, tokens, execution_mode, confirmation_token, chat_id },
			extra
		) => {
			const startedAt = Date.now();
			try {
				const resolvedOperationId = resolveOperationId({ operationId: operation_id, toolName: 'set_task_status' });
				const resolvedAgent = resolveAgentName({ agent, requestHeaders: extra.requestInfo?.headers });
				const resolvedModel = resolveModelName({ model, requestHeaders: extra.requestInfo?.headers });
				const config = requireProject();
				const projectId = config.currentProjectId;
				if (!projectId) throw new Error('NO_ACTIVE_PROJECT: No project selected.');
				const api = getApiClient();
				const currentTask = await resolveTaskByIdentifier(api, projectId, taskId);
				const resolvedExecutionMode = resolveExecutionMode(execution_mode);
				const payloadHash = stableHash({ status });
				const confirmationScope = `task:${projectId}:${currentTask.id}`;
				if (resolvedExecutionMode === 'preview') {
					const confirmation = issueConfirmationToken({
						tool: 'set_task_status',
						payloadHash,
						scope: confirmationScope,
						actor: resolvedAgent
					});
					return {
						content: [
							{
								type: 'text' as const,
								text: [
									`## set_task_status · preview`,
									`- task_id: ${currentTask.id}`,
									`- from_status: ${currentTask.status}`,
									`- to_status: ${status}`,
									`- operation_id: ${resolvedOperationId}`,
									`- payload_hash: ${payloadHash}`,
									`- confirmation_token: ${confirmation.token}`,
									`- confirmation_expires_at: ${confirmation.expiresAt}`,
									`- result_code: preview_ready`
								].join('\n')
							}
						]
					};
				}

				let confirmationMeta: ConfirmationMeta | undefined;
				if (isSensitiveConfirmationEnabled()) {
					if (!confirmation_token) {
						return {
							content: [
								{
									type: 'text' as const,
									text: 'CONFIRMATION_REQUIRED: call mode="preview" first, then execute with confirmation_token.'
								}
							],
							isError: true
						};
					}
					confirmationMeta = consumeConfirmationToken({
						token: confirmation_token,
						tool: 'set_task_status',
						payloadHash,
						scope: confirmationScope,
						actor: resolvedAgent
					});
				}

				const chatContext = resolveChatContext({
					chatId: chat_id,
					taskId: currentTask.id,
					requestHeaders: extra.requestInfo?.headers
				});
				const resolvedTokens = resolveTokens(JSON.stringify({ status }), tokens);
				const gitContext = getGitMetadata();
				const mcpPayload = buildMcpPayload({
					toolName: 'set_task_status',
					operationId: resolvedOperationId,
					payloadHash,
					agent: resolvedAgent,
					model: resolvedModel,
					chatContext,
					tokenSource: resolvedTokens.tokenSource,
					tokens: resolvedTokens.tokens,
					latencyMs: Date.now() - startedAt,
					changedFields: ['status'],
					requestHeaders: extra.requestInfo?.headers,
					confirmation: confirmationMeta,
					gitContext
				});

				const attemptsUsed = await patchTaskWithRetryAndVerification(
					api,
					projectId,
					currentTask.id,
					{ status, ...mcpPayload },
					(persistedTask) => persistedTask.status === status
				);

				trackToolCall({
					tool: 'set_task_status',
					input: { taskId, status, operation_id: resolvedOperationId },
					output: { status },
					latencyMs: Date.now() - startedAt,
					retries: Math.max(0, attemptsUsed - 1),
					chatId: chatContext.chatId,
					prompt: extractPromptFromHeaders(extra.requestInfo?.headers)
				});

				// Lifecycle tracking: mark status change for bound tasks
				if (bindingTracker.isBound(currentTask.id)) {
					if (status === 'in_progress') {
						bindingTracker.markInProgress(currentTask.id);
					} else if (status === 'in_review') {
						bindingTracker.markInReview(currentTask.id);
					}
				}

				// Build lifecycle state for response
				const lifecycleInfo = buildLifecycleInfoResponse(currentTask.id);

				return {
					content: [
						{
							type: 'text' as const,
							text: `✔ Task \`${currentTask.id.substring(0, 5)}\` status set to \`${status}\`.\n\n**Operation ID**: ${resolvedOperationId}\n**result_code**: applied${lifecycleInfo}`
						}
					]
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
				if (resolveIdempotencyErrorCode(error) === 'idempotency_conflict') {
					return {
						content: [{ type: 'text' as const, text: `Error: ${err.message}\nresult_code: idempotency_conflict` }],
						isError: true
					};
				}
				return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
			}
		}
	);
}

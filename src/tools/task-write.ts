import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AxiosInstance } from 'axios';
import { randomUUID } from 'node:crypto';
import { requireProjectAsync, saveConfigAsync } from '@lib/config.js';
import { getApiClientAsync } from '@lib/api.js';
import { throwAsMcpError } from '@lib/mcp-error.js';
import {
	ArtifactModeSchema,
	OperationIdSchema,
	PlanSchema,
	TaskIdentifierSchema,
	TaskStatusSchema,
	TokensSchema,
	WalkthroughSchema,
	CreateTaskInputSchema,
	CreateTaskMetadataSchema,
	CreateTaskGraphBulkInputSchema,
	CreateTaskGraphBulkMetadataSchema,
	sanitizeGraphTaskItems
} from '@lib/schemas.js';
import { resolveTaskByIdentifier, resolveTaskIdentifiers } from './task-common.js';
import { stableHash, trackToolCall, extractPromptFromHeaders } from '@lib/observability.js';
import { withOptional } from '@lib/utils.js';
import { getGitMetadata, resolveAffectedRepos, type GitContext } from '@lib/git.js';
import { consumeConfirmationToken, isSensitiveConfirmationEnabled, issueConfirmationToken } from '@lib/confirmation.js';
import { bindingTracker, lifecycleGate, isEnforcementActive, isStrictMode, LifecycleStep } from '@lifecycle/index.js';
import { createLogger } from '@lib/logger.js';

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

	lines.push('## Suggested Git Commit');
	lines.push(`\`${walkthrough.suggested_git_commit}\``);
	lines.push('');

	return lines.join('\n').trim();
}

const WRITE_RETRY_ATTEMPTS = 3;
const WRITE_RETRY_BACKOFF_MS = 250;
const DEFAULT_AGENT = 'mcp-client';
const DEFAULT_MODEL = 'unknown';

const logger = createLogger('task-write');

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
	reasoning?: number;
	toolUse?: number;
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
	const provided = options.operationId;
	if (provided !== undefined) {
		const trimmed = provided.trim();
		if (trimmed.length > 0) return trimmed;
	}
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
	const reasoning = toFiniteNumber(provided.reasoning);
	const toolUse = toFiniteNumber(provided.tool_use);
	const derivedTotal = total ?? (input !== undefined && output !== undefined ? input + output : estimateValue);

	const hasAnyExact = input !== undefined || output !== undefined || total !== undefined;
	const tokenSource: TokenSource = hasAnyExact
		? total !== undefined || (input !== undefined && output !== undefined)
			? 'exact'
			: 'mixed'
		: 'estimate';

	// Build tokens object, omitting undefined values explicitly
	const tokens: TokenTotals = {};
	if (input !== undefined) tokens.input = input;
	if (output !== undefined) tokens.output = output;
	if (derivedTotal !== undefined) tokens.total = derivedTotal;
	if (estimateValue !== undefined) tokens.estimate = estimateValue;
	if (reasoning !== undefined) tokens.reasoning = reasoning;
	if (toolUse !== undefined) tokens.toolUse = toolUse;

	return { tokens, tokenSource };
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
	
	// Build primary repo fields only if context exists
	const primaryFields = primaryContext
		? {
				git_branch: primaryContext.branch,
				git_commit_hash: primaryContext.commitHash,
				git_remote_url: primaryContext.remoteUrl,
				git_status: primaryContext.status
			}
		: {};

	// Build multi-repo contexts only if contexts exist
	const multiRepoContexts = contexts.length > 0
		? contexts.map((ctx) => ({
				branch: ctx.branch,
				commit_hash: ctx.commitHash,
				remote_url: ctx.remoteUrl,
				status: ctx.status,
				repo_name: ctx.repoName,
				repo_path: ctx.repoPath
			}))
		: undefined;

	// Build confirmation fields only if confirmation exists
	const confirmationFields = options.confirmation
		? {
				confirmation_id: options.confirmation.tokenId,
				confirmation_confirmed_at: options.confirmation.confirmedAt,
				confirmation_requested_at: options.confirmation.requestedAt
			}
		: {};

	return {
		mcpContext: {
			actor: options.agent,
			tool: options.toolName,
			chat_id: options.chatContext.chatId,
			session_id: options.chatContext.sessionId,
			last_seen_at: new Date().toISOString(),
			last_model: options.model,
			...primaryFields,
			...(multiRepoContexts ? { git_contexts: multiRepoContexts } : {}),
			...(options.affectedFiles ? { affected_files: options.affectedFiles } : {})
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
			...confirmationFields
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
				const resolvedOperationId = resolveOperationId({
					...withOptional('operationId', operation_id),
					toolName: 'update_task_plan'
				});
				const resolvedAgent = resolveAgentName({ agent, requestHeaders: extra.requestInfo?.headers });
				const resolvedModel = resolveModelName({ model, requestHeaders: extra.requestInfo?.headers });

				const config = await requireProjectAsync();
				const projectId = config.currentProjectId;
				if (!projectId) throw new Error('NO_ACTIVE_PROJECT: No project selected.');

				const api = await getApiClientAsync();
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

			// Lifecycle gate: validate state for bound tasks BEFORE proceeding
			// This enforces the strict lifecycle: bound → plan → in_progress → walkthrough → in_review
			if (isEnforcementActive() && bindingTracker.isBound(currentTask.id)) {
				const violation = lifecycleGate.checkViolation('update_task_plan', currentTask.id);

				if (violation) {
					const shouldBlock = isStrictMode();

					// In STRICT mode: block the operation
					if (shouldBlock) {
						trackToolCall({
							tool: 'update_task_plan',
							input: { taskId, operation_id: resolvedOperationId },
							error: violation.message,
							latencyMs: Date.now() - startedAt,
							...withOptional('prompt', extractPromptFromHeaders(extra.requestInfo?.headers))
						});

						return {
							content: [
								{
									type: 'text' as const,
									text: [
										`❌ LIFECYCLE VIOLATION — ${violation.code}`,
										`reason: ${violation.reason}`,
										`message: ${violation.message}`,
										violation.required_tool ? `required: ${violation.required_tool}` : '',
										violation.current_step ? `current_step: ${violation.current_step}` : '',
										`result_code: lifecycle_blocked`
									].filter(Boolean).join('\n')
								}
							],
							isError: true
						};
					}

					// In WARN mode: log and continue (but include warning in response)
					logger.warn(`[Lifecycle Warn] ${violation.message}`);
				}
			}

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

				const gitContext = await getGitMetadata();
				// Multi-repo detection: use files_affected from plan if available
				const affectedFiles = parsed.files_affected ?? [];
				const gitContexts = affectedFiles.length > 0
					? await resolveAffectedRepos(affectedFiles)
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
					...withOptional('confirmation', confirmationMeta),
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
					...withOptional('prompt', extractPromptFromHeaders(extra.requestInfo?.headers))
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
					...withOptional('prompt', extractPromptFromHeaders(extra.requestInfo?.headers))
				});
				if (error instanceof z.ZodError) {
					const issues = error.issues.map((i) => `- ${i.path.join('.')}: ${i.message}`).join('\n');
					return {
						content: [{ type: 'text' as const, text: `INVALID_INPUT: Plan validation failed:\n${issues}` }],
						isError: true
					};
				}
				if (resolveIdempotencyErrorCode(error) === 'idempotency_conflict') {
					const message = error instanceof Error ? error.message : String(error);
					return {
						content: [{ type: 'text' as const, text: `Error: ${message}\nresult_code: idempotency_conflict` }],
						isError: true
					};
				}
				throwAsMcpError(error, { toolName: 'update_task_plan' });
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
				const artifactMode = mode ?? 'mini';
				const payloadHash = stableHash({ walkthrough: parsed, mode: artifactMode });
				const resolvedOperationId = resolveOperationId({
					...withOptional('operationId', operation_id),
					toolName: 'update_task_walkthrough'
				});
				const resolvedAgent = resolveAgentName({ agent, requestHeaders: extra.requestInfo?.headers });
				const resolvedModel = resolveModelName({ model, requestHeaders: extra.requestInfo?.headers });

				const config = await requireProjectAsync();
				const projectId = config.currentProjectId;
				if (!projectId) throw new Error('NO_ACTIVE_PROJECT: No project selected.');

				const api = await getApiClientAsync();
				const currentTask = await resolveTaskByIdentifier(api, projectId, taskId);
				const walkthroughContent = renderWalkthroughMarkdown(parsed);
				const resolvedTokens = resolveTokens(walkthroughContent, tokens);
				const resolvedExecutionMode = resolveExecutionMode(execution_mode);
const confirmationScope = `task:${projectId}:${currentTask.id}`;
			const chatContext = resolveChatContext({
				chatId: chat_id,
				taskId: currentTask.id,
				requestHeaders: extra.requestInfo?.headers
			});

			// Lifecycle gate: validate state for bound tasks BEFORE proceeding
			// This enforces the strict lifecycle: bound → plan → in_progress → walkthrough → in_review
			if (isEnforcementActive() && bindingTracker.isBound(currentTask.id)) {
				const state = bindingTracker.getState(currentTask.id);

				// Walkthrough requires: plan written + in_progress status
				if (!state?.planWrittenAt || !state?.inProgressAt) {
					const violation = {
						code: 'LIFECYCLE_VIOLATION',
						reason: 'plan_missing' as const,
						message: state?.planWrittenAt
							? 'Cannot write walkthrough without in_progress status. Call set_task_status(in_progress) first.'
							: 'Cannot write walkthrough without a persisted plan. Call update_task_plan first.',
						required_tool: state?.planWrittenAt ? 'set_task_status' : 'update_task_plan',
						current_step: state?.planWrittenAt ? LifecycleStep.IN_PROGRESS : LifecycleStep.PLAN
					};

					const shouldBlock = isStrictMode();

					if (shouldBlock) {
						trackToolCall({
							tool: 'update_task_walkthrough',
							input: { taskId, operation_id: resolvedOperationId },
							error: violation.message,
							latencyMs: Date.now() - startedAt,
							...withOptional('prompt', extractPromptFromHeaders(extra.requestInfo?.headers))
						});

						return {
							content: [
								{
									type: 'text' as const,
									text: [
										`❌ LIFECYCLE VIOLATION — ${violation.code}`,
										`reason: ${violation.reason}`,
										`message: ${violation.message}`,
										`required: ${violation.required_tool}`,
										`current_step: ${violation.current_step}`,
										`result_code: lifecycle_blocked`
									].join('\n')
								}
							],
							isError: true
						};
					}

					logger.warn(`[Lifecycle Warn] ${violation.message}`);
				}
			}

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

				const gitContext = await getGitMetadata();
				// Multi-repo detection: use files_modified from walkthrough
				const affectedFiles = parsed.files_modified ?? [];
				const gitContexts = affectedFiles.length > 0
					? await resolveAffectedRepos(affectedFiles)
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
					...withOptional('confirmation', confirmationMeta),
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
					...withOptional('prompt', extractPromptFromHeaders(extra.requestInfo?.headers))
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
					...withOptional('prompt', extractPromptFromHeaders(extra.requestInfo?.headers))
				});
				if (error instanceof z.ZodError) {
					const issues = error.issues.map((i) => `- ${i.path.join('.')}: ${i.message}`).join('\n');
					return {
						content: [{ type: 'text' as const, text: `INVALID_INPUT: Walkthrough validation failed:\n${issues}` }],
						isError: true
					};
				}
				if (resolveIdempotencyErrorCode(error) === 'idempotency_conflict') {
					const message = error instanceof Error ? error.message : String(error);
					return {
						content: [{ type: 'text' as const, text: `Error: ${message}\nresult_code: idempotency_conflict` }],
						isError: true
					};
				}
				throwAsMcpError(error, { toolName: 'update_task_walkthrough' });
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
				const resolvedOperationId = resolveOperationId({
					...withOptional('operationId', operation_id),
					toolName: 'set_task_status'
				});
				const resolvedAgent = resolveAgentName({ agent, requestHeaders: extra.requestInfo?.headers });
				const resolvedModel = resolveModelName({ model, requestHeaders: extra.requestInfo?.headers });
				const config = await requireProjectAsync();
				const projectId = config.currentProjectId;
				if (!projectId) throw new Error('NO_ACTIVE_PROJECT: No project selected.');
				const api = await getApiClientAsync();
				const currentTask = await resolveTaskByIdentifier(api, projectId, taskId);
				const resolvedExecutionMode = resolveExecutionMode(execution_mode);
const payloadHash = stableHash({ status });
			const confirmationScope = `task:${projectId}:${currentTask.id}`;

			// Lifecycle gate: validate state for bound tasks BEFORE proceeding
			// This enforces the strict lifecycle: bound → plan → in_progress → walkthrough → in_review
			if (isEnforcementActive() && bindingTracker.isBound(currentTask.id)) {
				const state = bindingTracker.getState(currentTask.id);

				// Rule: in_progress requires plan
				if (status === 'in_progress' && !state?.planWrittenAt) {
					const violation = {
						code: 'LIFECYCLE_VIOLATION',
						reason: 'plan_missing' as const,
						message: 'Cannot set status to in_progress without a persisted plan. Call update_task_plan first.',
						required_tool: 'update_task_plan',
						current_step: LifecycleStep.PLAN
					};

					if (isStrictMode()) {
						trackToolCall({
							tool: 'set_task_status',
							input: { taskId, status, operation_id: resolvedOperationId },
							error: violation.message,
							latencyMs: Date.now() - startedAt,
							...withOptional('prompt', extractPromptFromHeaders(extra.requestInfo?.headers))
						});

						return {
							content: [
								{
									type: 'text' as const,
									text: [
										`❌ LIFECYCLE VIOLATION — ${violation.code}`,
										`reason: ${violation.reason}`,
										`message: ${violation.message}`,
										`required: ${violation.required_tool}`,
										`current_step: ${violation.current_step}`,
										`result_code: lifecycle_blocked`
									].join('\n')
								}
							],
							isError: true
						};
					}

					logger.warn(`[Lifecycle Warn] ${violation.message}`);
				}

				// Rule: in_review requires walkthrough
				if (status === 'in_review' && !state?.walkthroughWrittenAt) {
					const violation = {
						code: 'LIFECYCLE_VIOLATION',
						reason: 'walkthrough_missing' as const,
						message: 'Cannot set status to in_review without a persisted walkthrough. Call update_task_walkthrough first.',
						required_tool: 'update_task_walkthrough',
						current_step: LifecycleStep.WALKTHROUGH
					};

					if (isStrictMode()) {
						trackToolCall({
							tool: 'set_task_status',
							input: { taskId, status, operation_id: resolvedOperationId },
							error: violation.message,
							latencyMs: Date.now() - startedAt,
							...withOptional('prompt', extractPromptFromHeaders(extra.requestInfo?.headers))
						});

						return {
							content: [
								{
									type: 'text' as const,
									text: [
										`❌ LIFECYCLE VIOLATION — ${violation.code}`,
										`reason: ${violation.reason}`,
										`message: ${violation.message}`,
										`required: ${violation.required_tool}`,
										`current_step: ${violation.current_step}`,
										`result_code: lifecycle_blocked`
									].join('\n')
								}
							],
							isError: true
						};
					}

					logger.warn(`[Lifecycle Warn] ${violation.message}`);
				}
			}

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
				const gitContext = await getGitMetadata();
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
					...withOptional('confirmation', confirmationMeta),
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
					...withOptional('prompt', extractPromptFromHeaders(extra.requestInfo?.headers))
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
					...withOptional('prompt', extractPromptFromHeaders(extra.requestInfo?.headers))
				});
				if (resolveIdempotencyErrorCode(error) === 'idempotency_conflict') {
					const message = error instanceof Error ? error.message : String(error);
					return {
						content: [{ type: 'text' as const, text: `Error: ${message}\nresult_code: idempotency_conflict` }],
						isError: true
					};
				}
				throwAsMcpError(error, { toolName: 'set_task_status' });
			}
		}
	);

	/**
	 * Sync active project from binding tracker to local config.
	 * This tool should ONLY be called in write-runtime mode after a task has been
	 * resolved in read-runtime mode.
	 *
	 * Reads the current bound task from the local binding tracker and persists
	 * the project ID and name to ~/.fnk/config.json.
	 *
	 * This is needed because resolve_session_task in read-runtime mode no longer
	 * writes to config (to maintain read-only guarantees), so write-runtime must
	 * sync the project after the fact.
	 */
	server.tool(
		'sync_active_project_from_binding',
		'Synchronize the active project from the local binding tracker to the local config file. Use this after binding a task in read-runtime mode.',
		{},
		async (_args, extra) => {
			const startedAt = Date.now();

			try {
				const currentTaskId = bindingTracker.getCurrentTaskId();

				if (!currentTaskId) {
					return {
						content: [
							{
								type: 'text' as const,
								text: 'Error: No active task bound. Call resolve_session_task in read-runtime mode first, then use this tool in write-runtime mode.'
							}
						],
						isError: true
					};
				}

				const boundTask = bindingTracker.getBoundTask(currentTaskId);

				if (!boundTask) {
					return {
						content: [
							{
								type: 'text' as const,
								text: 'Error: Could not retrieve bound task information.'
							}
						],
						isError: true
					};
				}

				// Validate auth and project, then create API client
				await requireProjectAsync();
				const api = await getApiClientAsync();
				const { data: projects } = await api.get<Array<{ id: string; name: string }>>('/projects');
				const resolvedProject = projects.find((project) => project.id === boundTask.projectId);

				// Write to local config
				await saveConfigAsync({
					currentProjectId: boundTask.projectId,
					currentProjectName: resolvedProject?.name
				});

				trackToolCall({
					tool: 'sync_active_project_from_binding',
					input: {},
					output: { project_id: boundTask.projectId, project_name: resolvedProject?.name },
					latencyMs: Date.now() - startedAt,
					sessionId: extra.sessionId,
					chatId: boundTask.chatId,
					prompt: extractPromptFromHeaders(extra.requestInfo?.headers)
				});

				return {
					content: [
						{
							type: 'text' as const,
							text: `## Project Synced\n\n- project_id: ${boundTask.projectId}\n- project_name: ${resolvedProject?.name || '(unknown)'}\n\nThe active project has been written to \`~/.fnk/config.json\`.`
						}
					]
				};
			} catch (error) {
				trackToolCall({
					tool: 'sync_active_project_from_binding',
					input: {},
					error: error instanceof Error ? error.message : String(error),
					latencyMs: Date.now() - startedAt,
					...withOptional('prompt', extractPromptFromHeaders(extra.requestInfo?.headers))
				});
				throwAsMcpError(error, { toolName: 'sync_active_project_from_binding' });
			}
		}
	);

	// ─── MTB-03: fenkit_write_create_task ──────────────────────────────────────────────
	/**
	 * Create a single task via MCP pipeline.
	 * Reuses backend createTaskViaMcpPipeline with full idempotency semantics.
	 */
	server.tool(
		'fenkit_write_create_task',
		'Create a new task in the active project via MCP pipeline with idempotency.',
		{
			task: CreateTaskInputSchema.describe('Task fields for creation'),
			metadata: CreateTaskMetadataSchema.describe('MCP metadata envelope'),
		},
		{ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
		async ({ task, metadata }, extra) => {
			const startedAt = Date.now();
			try {
				const parsedTask = CreateTaskInputSchema.parse(task);
				const parsedMetadata = CreateTaskMetadataSchema.parse(metadata);

				// Resolve project
				const config = await requireProjectAsync();
				const projectId = parsedMetadata.projectId ?? config.currentProjectId;
				if (!projectId) throw new Error('NO_ACTIVE_PROJECT: No project selected.');

				const api = await getApiClientAsync();

				// Resolve operation_id
				const resolvedOperationId = resolveOperationId({
					...(parsedMetadata.operation_id ? { operationId: parsedMetadata.operation_id } : {}),
					toolName: 'fenkit_write_create_task'
				});
				const resolvedAgent = resolveAgentName({
					agent: parsedMetadata.agent,
					requestHeaders: extra.requestInfo?.headers
				});
				const resolvedModel = resolveModelName({
					model: parsedMetadata.model,
					requestHeaders: extra.requestInfo?.headers
				});

				// Resolve execution mode
				const resolvedExecutionMode = resolveExecutionMode(parsedMetadata.execution_mode);
				const payloadHash = stableHash({ task: parsedTask, operationId: resolvedOperationId });
				const confirmationScope = `task:${projectId}:create`;

				// Prepare MCP payload
				const chatContext = resolveChatContext({
					chatId: parsedMetadata.chat_id,
					taskId: 'new',
					requestHeaders: extra.requestInfo?.headers
				});
				const taskContent = JSON.stringify(parsedTask);
				const resolvedTokens = resolveTokens(taskContent, parsedMetadata.tokens);

				// Preview mode
				if (resolvedExecutionMode === 'preview') {
					const confirmation = issueConfirmationToken({
						tool: 'fenkit_write_create_task',
						payloadHash,
						scope: confirmationScope,
						actor: resolvedAgent
					});
					return {
						content: [
							{
								type: 'text' as const,
								text: [
									`## fenkit_write_create_task · preview`,
									`- project_id: ${projectId}`,
									`- operation_id: ${resolvedOperationId}`,
									`- title: ${parsedTask.title}`,
									`- status: ${parsedTask.status ?? 'todo'}`,
									`- priority: ${parsedTask.priority ?? 'medium'}`,
									`- payload_hash: ${payloadHash}`,
									`- confirmation_token: ${confirmation.token}`,
									`- confirmation_expires_at: ${confirmation.expiresAt}`,
									`- result_code: preview_ready`
								].join('\n')
							}
						]
					};
				}

				// Confirmation handling
				let confirmationMeta: ConfirmationMeta | undefined;
				if (isSensitiveConfirmationEnabled()) {
					if (!parsedMetadata.confirmation_token) {
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
						token: parsedMetadata.confirmation_token,
						tool: 'fenkit_write_create_task',
						payloadHash,
						scope: confirmationScope,
						actor: resolvedAgent
					});
				}

				const gitContext = await getGitMetadata();
				const mcpPayload = buildMcpPayload({
					toolName: 'fenkit_write_create_task',
					operationId: resolvedOperationId,
					payloadHash,
					agent: resolvedAgent,
					model: resolvedModel,
					chatContext,
					tokenSource: resolvedTokens.tokenSource,
					tokens: resolvedTokens.tokens,
					latencyMs: Date.now() - startedAt,
					changedFields: ['id', 'title', 'status', 'priority', 'description'],
					requestHeaders: extra.requestInfo?.headers,
					...withOptional('confirmation', confirmationMeta),
					gitContext
				});

				// Build backend DTO
				const resolvedBlockedByTaskIds = parsedTask.blockedByTaskIds?.length
					? await resolveTaskIdentifiers(api, projectId, parsedTask.blockedByTaskIds)
					: undefined;

				const createDto = {
					task: {
						title: parsedTask.title,
						description: parsedTask.description,
						status: parsedTask.status ?? 'todo',
						priority: parsedTask.priority ?? 'medium',
						assigneeId: parsedTask.assigneeId,
						blockedByTaskIds: resolvedBlockedByTaskIds,
						// Workstream fields for scoped execution
						workstreamId: parsedTask.workstreamId,
						rootTaskId: parsedTask.rootTaskId,
						workstreamTag: parsedTask.workstreamTag,
					},
					mcpContext: mcpPayload.mcpContext,
					mcpEvent: mcpPayload.mcpEvent
				};

				// Call backend
				const response = await api.post(`/projects/${projectId}/tasks/mcp`, createDto);
				const createdTask = response.data;

				trackToolCall({
					tool: 'fenkit_write_create_task',
					input: { operation_id: resolvedOperationId, title: parsedTask.title },
					output: { task_id: createdTask.id, status: createdTask.status },
					latencyMs: Date.now() - startedAt,
					chatId: chatContext.chatId,
					...withOptional('prompt', extractPromptFromHeaders(extra.requestInfo?.headers))
				});

				return {
					content: [
						{
							type: 'text' as const,
							text: [
								`✔ Task created \`${createdTask.id.substring(0, 5)}\``,
								``,
								`**Title**: ${createdTask.title}`,
								`**Status**: ${createdTask.status}`,
								`**Priority**: ${createdTask.priority}`,
								`**Operation ID**: ${resolvedOperationId}`,
								`**result_code**: created`
							].join('\n')
						}
					]
				};
			} catch (error) {
				trackToolCall({
					tool: 'fenkit_write_create_task',
					input: { operation_id: metadata?.operation_id },
					error: error instanceof Error ? error.message : String(error),
					latencyMs: Date.now() - startedAt,
					...withOptional('prompt', extractPromptFromHeaders(extra.requestInfo?.headers))
				});
				if (error instanceof z.ZodError) {
					const issues = error.issues.map((i) => `- ${i.path.join('.')}: ${i.message}`).join('\n');
					return {
						content: [{ type: 'text' as const, text: `INVALID_INPUT: Task validation failed:\n${issues}` }],
						isError: true
					};
				}
				if (resolveIdempotencyErrorCode(error) === 'idempotency_conflict') {
					const message = error instanceof Error ? error.message : String(error);
					return {
						content: [{ type: 'text' as const, text: `Error: ${message}\nresult_code: idempotency_conflict` }],
						isError: true
					};
				}
				// Handle specific backend error codes
				const errorMessage = error instanceof Error ? error.message : String(error);
				if (errorMessage.includes('agentic_flow_cannot_create_done_task')) {
					return {
						content: [
							{
								type: 'text' as const,
								text: `Error: ${errorMessage}\nresult_code: policy_violation`
							}
						],
						isError: true
					};
				}
				throwAsMcpError(error, { toolName: 'fenkit_write_create_task' });
			}
		}
	);

// ─── MTB-05: fenkit_write_create_task_graph_bulk ───────────────────────────────────
	/**
	 * Create multiple tasks as a graph with shared graph-level metadata.
	 * Graph mode defines workstream context once and applies it to all items.
	 */
	server.tool(
		'fenkit_write_create_task_graph_bulk',
		'Create multiple tasks as a graph with shared graph-level metadata. Graph mode defines workstream context once and applies it to all items, supporting root task resolution, scope enforcement, and atomic transactions.',
		{
			graph: CreateTaskGraphBulkInputSchema.shape.graph.describe('Graph-level metadata'),
			items: CreateTaskGraphBulkInputSchema.shape.items.describe('Task items to create'),
			metadata: CreateTaskGraphBulkMetadataSchema.describe('Batch metadata envelope'),
		},
		{ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
		async ({ graph, items, metadata }, extra) => {
			const startedAt = Date.now();
			try {
				// Sanitize graph items: strip unknown fields before validation
				const sanitizedItems = sanitizeGraphTaskItems(items);
				const parsedInput = CreateTaskGraphBulkInputSchema.parse({ graph, items: sanitizedItems });
				const parsedMetadata = CreateTaskGraphBulkMetadataSchema.parse(metadata);

				// Resolve common fields
				const resolvedOperationIdPrefix = resolveOperationId({
					...(parsedMetadata.operation_id_prefix
						? { operationId: parsedMetadata.operation_id_prefix }
						: {}),
					toolName: 'fenkit_write_create_task_graph_bulk'
				});

				// Validate graph items have client_ref for graph mode
				const itemsWithoutClientRef = parsedInput.items.filter((item) => !item.client_ref);
				if (itemsWithoutClientRef.length > 0) {
					return {
						content: [
							{
								type: 'text' as const,
								text: [
									'GRAPH_VALIDATION_ERROR: Graph mode requires client_ref on all items.',
									`Missing client_ref on ${itemsWithoutClientRef.length} item(s).`,
									'Use client_ref to enable in-batch dependency resolution via @client_ref.'
								].join('\n')
							}
						],
						isError: true
					};
				}

				// Validate root resolution strategy
				const rootRef = parsedInput.graph.rootRef;
				const hasExplicitRoots = parsedInput.items.some((item) => item.isRootTask);
				let rootResolutionStrategy: string;
				if (rootRef) {
					rootResolutionStrategy = `rootRef: ${rootRef}`;
				} else if (hasExplicitRoots) {
					rootResolutionStrategy = 'isRootTask flag';
				} else {
					rootResolutionStrategy = 'inferred (first item)';
				}

				// Check for rootRef validity if provided
				if (rootRef && !parsedInput.items.find((item) => item.client_ref === rootRef)) {
					return {
						content: [
							{
								type: 'text' as const,
								text: [
									'GRAPH_VALIDATION_ERROR: rootRef not found in items.',
									`rootRef "${rootRef}" does not match any client_ref.`,
									'Available client_refs: ' + parsedInput.items.map((i) => i.client_ref).join(', ')
								].join('\n')
							}
						],
						isError: true
					};
				}

				// Validate dependencies reference valid client_refs or task IDs
				const clientRefs = new Set(parsedInput.items.map((item) => item.client_ref));
				const invalidDeps: string[] = [];
				for (const item of parsedInput.items) {
					if (item.blockedBy) {
						for (const dep of item.blockedBy) {
							// Skip external task IDs (those without @ prefix)
							if (!dep.startsWith('@') && !clientRefs.has(dep)) {
								// Could be an external task ID, that's valid
								continue;
							}
							// For @ references, validate they point to known client_refs
							if (dep.startsWith('@')) {
								const refTarget = dep.slice(1);
								if (!clientRefs.has(refTarget)) {
									invalidDeps.push(`${item.client_ref} -> ${dep}`);
								}
							}
						}
					}
				}
				if (invalidDeps.length > 0) {
					return {
						content: [
							{
								type: 'text' as const,
								text: [
									'GRAPH_VALIDATION_ERROR: Invalid dependency references.',
									...invalidDeps.map((d) => `  - ${d}`),
									'All @client_ref references must point to items in this batch.'
								].join('\n')
							}
						],
						isError: true
					};
				}

				// Resolve project
				const config = await requireProjectAsync();
				const projectId = parsedMetadata.projectId ?? config.currentProjectId;
				if (!projectId) throw new Error('NO_ACTIVE_PROJECT: No project selected.');

				const api = await getApiClientAsync();

				const resolvedAgent = resolveAgentName({
					agent: parsedMetadata.agent,
					requestHeaders: extra.requestInfo?.headers
				});

				// Resolve execution mode
				const resolvedExecutionMode = resolveExecutionMode(parsedMetadata.execution_mode);
				const confirmationScope = `task:${projectId}:graph-bulk-create`;

				// Preview mode
				if (resolvedExecutionMode === 'preview') {
					const confirmation = issueConfirmationToken({
						tool: 'fenkit_write_create_task_graph_bulk',
						payloadHash: stableHash({
							graph: parsedInput.graph,
							items: parsedInput.items,
							operationIdPrefix: resolvedOperationIdPrefix
						}),
						scope: confirmationScope,
						actor: resolvedAgent
					});

					const strictScope = parsedInput.graph.strictScope ?? true;
					const atomic = parsedMetadata.atomic ?? true;

					return {
						content: [
							{
								type: 'text' as const,
								text: [
									`## fenkit_write_create_task_graph_bulk · preview`,
									`- project_id: ${projectId}`,
									`- operation_id_prefix: ${resolvedOperationIdPrefix}`,
									`- item_count: ${parsedInput.items.length}`,
									`- root_resolution_strategy: ${rootResolutionStrategy}`,
									`- workstream_id: ${parsedInput.graph.workstreamId ?? 'auto-generated'}`,
									`- workstream_tag: ${parsedInput.graph.workstreamTag ?? 'none'}`,
									`- scope_key: ${parsedInput.graph.scopeKey}`,
									`- strict_scope: ${String(strictScope)}`,
									`- atomic: ${String(atomic)}`,
									`- confirmation_token: ${confirmation.token}`,
									`- confirmation_expires_at: ${confirmation.expiresAt}`,
									`- result_code: preview_ready`
								].join('\n')
							}
						]
					};
				}

				// Confirmation handling
				let confirmationMeta: ConfirmationMeta | undefined;
				if (isSensitiveConfirmationEnabled()) {
					if (!parsedMetadata.confirmation_token) {
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
						token: parsedMetadata.confirmation_token,
						tool: 'fenkit_write_create_task_graph_bulk',
						payloadHash: stableHash({
							graph: parsedInput.graph,
							items: parsedInput.items,
							operationIdPrefix: resolvedOperationIdPrefix
						}),
						scope: confirmationScope,
						actor: resolvedAgent
					});
				}

				// Build graph-native bulk request DTO
				const graphTasks = parsedInput.items.map((item) => {
					// Resolve @client_ref dependencies
					const resolvedBlockedBy = (item.blockedBy ?? []).map((dep) => {
						if (dep.startsWith('@')) {
							// Keep @ references for backend resolution
							return dep;
						}
						// External task IDs pass through as-is
						return dep;
					});

					return {
						client_ref: item.client_ref,
						title: item.title,
						description: item.description,
						status: item.status ?? 'todo',
						priority: item.priority ?? 'medium',
						assigneeId: item.assigneeId,
						isRootTask: item.isRootTask ?? false,
						blockedBy: resolvedBlockedBy,
						tags: item.tags,
					};
				});

				const graphBulkDto = {
					graph: {
						workstreamId: parsedInput.graph.workstreamId,
						workstreamTag: parsedInput.graph.workstreamTag,
						scopeKey: parsedInput.graph.scopeKey,
						contextSummary: parsedInput.graph.contextSummary,
						strictScope: parsedInput.graph.strictScope ?? true,
						rootRef: parsedInput.graph.rootRef
					},
					items: graphTasks,
					operation_id_prefix: resolvedOperationIdPrefix,
					atomic: parsedMetadata.atomic ?? true
				};

				// Call backend graph-bulk endpoint
				const response = await api.post(`/projects/${projectId}/tasks/graph-bulk`, graphBulkDto);
				const graphBulkResponse = response.data;

				// Map backend response to MCP-friendly format including graph identity
				const results = graphBulkResponse.results ?? [];
				const summaryLines = [
					`✔ Graph bulk create completed`,
					``
				];

				// Add graph identity section
				const workstreamId = graphBulkResponse.workstream_id ?? parsedInput.graph.workstreamId ?? 'N/A';
				const rootTaskId = graphBulkResponse.root_task_id ?? 'N/A';
				const workstreamTag = graphBulkResponse.workstream_tag ?? parsedInput.graph.workstreamTag ?? 'none';
				const scopeKey = graphBulkResponse.scope_key ?? parsedInput.graph.scopeKey ?? 'N/A';
				const strictScope = graphBulkResponse.strict_scope ?? (parsedInput.graph.strictScope ?? true);

				summaryLines.push('**Graph Identity**:');
				summaryLines.push(`- workstream_id: ${workstreamId}`);
				summaryLines.push(`- root_task_id: ${rootTaskId}`);
				summaryLines.push(`- workstream_tag: ${workstreamTag}`);
				summaryLines.push(`- scope_key: ${scopeKey}`);
				summaryLines.push(`- strict_scope: ${strictScope}`);
				summaryLines.push(``);

				summaryLines.push(`**Total items**: ${results.length}`);
				summaryLines.push(`**Created**: ${graphBulkResponse.created ?? 0}`);
				summaryLines.push(`**Replayed**: ${graphBulkResponse.replayed ?? 0}`);
				summaryLines.push(`**Conflicts**: ${graphBulkResponse.conflicts ?? 0}`);
				summaryLines.push(`**Errors**: ${graphBulkResponse.errors ?? 0}`);
				summaryLines.push(``);

				// Add per-item details with client_ref mapping
				const detailLines: string[] = [];
				for (const result of results) {
					const status = result.status ?? 'error';
					const taskId = result.task_id ?? result.replayed_task_id ?? 'N/A';
					const clientRef = result.client_ref ?? 'N/A';
					let line = `- [${status.toUpperCase()}]`;
					if (status === 'created' || status === 'replayed') {
						line += ` ${taskId.substring(0, 5)} (client_ref: ${clientRef})`;
					} else {
						line += ` ${result.error_code ?? 'unknown'}`;
						if (result.error_reason) line += `: ${result.error_reason.substring(0, 40)}`;
						line += ` (client_ref: ${clientRef})`;
					}
					detailLines.push(line);
				}
				if (detailLines.length > 0) {
					summaryLines.push('**Items**:');
					summaryLines.push(...detailLines.slice(0, 10));
					if (detailLines.length > 10) {
						summaryLines.push(`  ... and ${detailLines.length - 10} more`);
					}
				}

				// Determine overall result_code
				const hasErrors = (graphBulkResponse.errors ?? 0) > 0;
				const hasConflicts = (graphBulkResponse.conflicts ?? 0) > 0;
				let resultCode = 'created';
				if (hasErrors && (graphBulkResponse.created ?? 0) === 0) {
					resultCode = 'failed';
				} else if (hasErrors || hasConflicts) {
					resultCode = 'partial';
				}
				summaryLines.push(``);
				summaryLines.push(`**result_code**: ${resultCode}`);

				trackToolCall({
					tool: 'fenkit_write_create_task_graph_bulk',
					input: {
						operation_id_prefix: resolvedOperationIdPrefix,
						items_count: parsedInput.items.length,
						scope_key: parsedInput.graph.scopeKey
					},
					output: {
						created: graphBulkResponse.created ?? 0,
						replayed: graphBulkResponse.replayed ?? 0,
						conflicts: graphBulkResponse.conflicts ?? 0,
						errors: graphBulkResponse.errors ?? 0,
						workstream_id: workstreamId,
						root_task_id: rootTaskId
					},
					latencyMs: Date.now() - startedAt,
					...withOptional('confirmation', confirmationMeta),
					...withOptional('prompt', extractPromptFromHeaders(extra.requestInfo?.headers))
				});

				return {
					content: [
						{
							type: 'text' as const,
							text: summaryLines.join('\n')
						}
					]
				};
			} catch (error) {
				trackToolCall({
					tool: 'fenkit_write_create_task_graph_bulk',
					input: {
						operation_id_prefix: metadata?.operation_id_prefix,
						items_count: items?.length
					},
					error: error instanceof Error ? error.message : String(error),
					latencyMs: Date.now() - startedAt,
					...withOptional('prompt', extractPromptFromHeaders(extra.requestInfo?.headers))
				});
				if (error instanceof z.ZodError) {
					const issues = error.issues.map((i) => `- ${i.path.join('.')}: ${i.message}`).join('\n');
					return {
						content: [{ type: 'text' as const, text: `INVALID_INPUT: Graph bulk validation failed:\n${issues}` }],
						isError: true
					};
				}
				throwAsMcpError(error, { toolName: 'fenkit_write_create_task_graph_bulk' });
			}
		}
	);
}

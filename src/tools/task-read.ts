import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { requireProject } from '../config.js';
import { getApiClient, formatApiError } from '../api.js';
import { stripPrivate, stripPrivateDeep, truncateDeterministic } from '../utils.js';
import { resolveTaskByIdentifier, updateTaskLastRetrievedAt, type TaskResponse } from './task-common.js';
import { TaskIdentifierSchema } from '../schemas.js';
import { extractPromptFromHeaders, trackToolCall } from '../observability.js';

const STATUS_ICONS: Record<string, string> = {
	todo: '📋',
	in_progress: '🏗️',
	in_review: '🔍',
	done: '✅',
	backlog: '📥',
	frozen: '❄️'
};

const SectionSchema = z.enum(['plan', 'walkthrough', 'metadata', 'history']);
const StatusFilterSchema = z
	.string()
	.trim()
	.min(1)
	.max(120)
	.regex(/^[a-z_,]+$/i, 'Status filter must be comma-separated lowercase values');

const DEFAULT_HISTORY_LIMIT = 3;
const MAX_HISTORY_LIMIT = 20;
const DEFAULT_MAX_CHARS = 3500;
const MAX_ALLOWED_CHARS = 12000;

interface CompactOptions {
	historyLimit: number;
	maxChars: number;
}

function clampNumber(value: number | undefined, fallback: number, min: number, max: number): number {
	if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stripAndTruncate(content: string, maxChars: number): string {
	return truncateDeterministic(stripPrivate(content), maxChars);
}

async function fetchTasksByStatus(projectId: string, statusFilter: string): Promise<TaskResponse[]> {
	const api = getApiClient();
	const params = new URLSearchParams();
	params.set('status', statusFilter);
	const { data } = await api.get<TaskResponse[]>(`/projects/${projectId}/tasks?${params.toString()}`);
	return data;
}

function compactExecution(execution: unknown): Record<string, unknown> | null {
	if (!isRecord(execution)) return null;
	const git = isRecord(execution.git) ? execution.git : {};
	return {
		timestamp: execution.timestamp,
		executed_at: execution.executed_at ?? execution.timestamp,
		'Executed at': execution.executed_at ?? execution.timestamp,
		model: execution.model,
		agent: execution.agent,
		'Agent/Client': execution.agent_client ?? execution.agent,
		provider: execution.provider,
		durationMs: execution.durationMs,
		duration: execution.duration ?? execution.durationMs,
		token_source: execution.token_source,
		chat_id: execution.chat_id,
		chat_name: execution.chat_name,
		chat_title: execution.chat_title ?? execution.chat_name,
		'Chat title': execution.chat_title ?? execution.chat_name,
		git_branch: execution.git_branch ?? git.branch,
		'Git branch': execution.git_branch ?? git.branch,
		git_repo: execution.git_repo ?? git.repo,
		'Git Repo': execution.git_repo ?? git.repo,
		tokens: isRecord(execution.tokens)
			? { estimate: execution.tokens.estimate, total: execution.tokens.total }
			: undefined,
		total_tokens: execution.total_tokens ?? execution['total tokens'],
		'total tokens': execution.total_tokens ?? execution['total tokens']
	};
}

function getMcpSchemas(meta: Record<string, unknown>): { planSchema?: unknown; walkthroughSchema?: unknown } {
	const mcp = meta.mcp;
	if (!isRecord(mcp)) return {};
	return {
		planSchema: mcp.planSchema,
		walkthroughSchema: mcp.walkthroughSchema
	};
}

function sanitizeMetadata(meta: Record<string, unknown>): Record<string, unknown> {
	const sanitized = stripPrivateDeep(meta);
	return isRecord(sanitized) ? sanitized : {};
}

function renderCompactContext(task: TaskResponse, options: CompactOptions): string {
	const meta = sanitizeMetadata((task.implementationMetadata as Record<string, unknown>) || {});
	const { planSchema, walkthroughSchema } = getMcpSchemas(meta);
	const mcp = isRecord(meta.mcp) ? meta.mcp : {};
	const mcpAnalytics = isRecord(mcp.analytics) ? mcp.analytics : {};
	const overallTokens = isRecord(mcpAnalytics.overallTokens) ? mcpAnalytics.overallTokens : null;
	const latestChat = isRecord(mcp.chat) ? mcp.chat : null;
	const history = Array.isArray(meta.history) ? meta.history : [];
	const compactHistory = history
		.slice(-options.historyLimit)
		.map((item) => compactExecution(item))
		.filter(Boolean);
	const latestExecution = compactExecution(meta.lastExecution);

	const sections: string[] = [];
	sections.push(`# ${task.title}`);
	sections.push('');
	sections.push(
		`**ID**: \`${task.id}\` · **Status**: ${STATUS_ICONS[task.status] || ''} ${task.status} · **Priority**: ${task.priority}`
	);
	if (task.tags?.length) {
		sections.push(`**Tags**: ${task.tags.map((t) => t.name).join(', ')}`);
	}
	sections.push('');

	sections.push('## Description (compact)');
	sections.push(task.description ? stripAndTruncate(task.description, options.maxChars) : '_(no description)_');
	sections.push('');

	if (isRecord(planSchema)) {
		sections.push('## Plan Summary');
		sections.push(`- Summary: ${String(planSchema.summary || 'n/a')}`);
		if (Array.isArray(planSchema.steps)) {
			sections.push(`- Steps: ${(planSchema.steps as unknown[]).length}`);
		}
		if (Array.isArray(planSchema.files_affected)) {
			sections.push(`- Files affected: ${(planSchema.files_affected as unknown[]).length}`);
		}
		sections.push('');
	}

	if (isRecord(walkthroughSchema)) {
		sections.push('## Walkthrough Summary');
		sections.push(`- Summary: ${String(walkthroughSchema.summary || 'n/a')}`);
		if (Array.isArray(walkthroughSchema.changes)) {
			sections.push(`- Changes: ${(walkthroughSchema.changes as unknown[]).length}`);
		}
		if (Array.isArray(walkthroughSchema.files_modified)) {
			sections.push(`- Files modified: ${(walkthroughSchema.files_modified as unknown[]).length}`);
		}
		sections.push('');
	}

	if (latestExecution) {
		sections.push('## Latest Execution');
		sections.push('```json');
		sections.push(JSON.stringify(latestExecution));
		sections.push('```');
		sections.push('');
	}

	if (latestChat) {
		sections.push('## Latest Chat Context');
		sections.push(`- Chat ID: ${String(latestChat.id || 'n/a')}`);
		sections.push(`- Chat name: ${String(latestChat.name || 'n/a')}`);
		sections.push(`- Last seen: ${String(latestChat.lastSeenAt || 'n/a')}`);
		sections.push('');
	}

	if (overallTokens) {
		sections.push('## Cumulative Tokens');
		sections.push('```json');
		sections.push(
			JSON.stringify({
				source: mcpAnalytics.overallTokenSource,
				totals: overallTokens
			})
		);
		sections.push('```');
		sections.push('');
	}

	if (compactHistory.length > 0) {
		sections.push(`## Execution History (last ${compactHistory.length})`);
		sections.push('```json');
		sections.push(JSON.stringify(compactHistory));
		sections.push('```');
		sections.push('');
	}

	sections.push(
		'> Compact mode intentionally omits full plan/walkthrough and full metadata. Call `get_task_context_full` or `get_task_section` if needed.'
	);

	return sections.join('\n');
}

function renderFullContext(task: TaskResponse): string {
	const sections: string[] = [];
	sections.push(`# ${task.title}`);
	sections.push('');
	sections.push(
		`**ID**: \`${task.id}\` · **Status**: ${STATUS_ICONS[task.status] || ''} ${task.status} · **Priority**: ${task.priority}`
	);

	if (task.tags?.length) {
		sections.push(`**Tags**: ${task.tags.map((t) => t.name).join(', ')}`);
	}
	sections.push('');

	sections.push('## Description');
	sections.push(task.description ? stripPrivate(task.description) : '_(no description)_');
	sections.push('');

	if (task.plan) {
		sections.push('## Plan');
		sections.push(stripPrivate(task.plan));
		sections.push('');
	}

	if (task.walkthrough) {
		sections.push('## Walkthrough');
		sections.push(stripPrivate(task.walkthrough));
		sections.push('');
	}

	const metadata = sanitizeMetadata((task.implementationMetadata as Record<string, unknown>) || {});
	if (Object.keys(metadata).length > 0) {
		sections.push('## Implementation Metadata');
		sections.push('```json');
		sections.push(JSON.stringify(metadata, null, 2));
		sections.push('```');
		sections.push('');
	}

	return sections.join('\n');
}

function renderTaskSection(
	task: TaskResponse,
	section: z.infer<typeof SectionSchema>,
	options: CompactOptions
): string {
	const metadata = sanitizeMetadata((task.implementationMetadata as Record<string, unknown>) || {});
	const lines: string[] = [];
	lines.push(`# ${task.title}`);
	lines.push('');
	lines.push(`**ID**: \`${task.id}\``);
	lines.push('');

	if (section === 'plan') {
		lines.push('## Plan');
		const content = task.plan || '';
		lines.push(content ? stripAndTruncate(content, options.maxChars) : '_(no plan)_');
		return lines.join('\n');
	}

	if (section === 'walkthrough') {
		lines.push('## Walkthrough');
		const content = task.walkthrough || '';
		lines.push(content ? stripAndTruncate(content, options.maxChars) : '_(no walkthrough)_');
		return lines.join('\n');
	}

	if (section === 'history') {
		const history = Array.isArray(metadata.history) ? metadata.history : [];
		const compactHistory = history
			.slice(-options.historyLimit)
			.map((item) => compactExecution(item))
			.filter(Boolean);
		lines.push(`## History (last ${compactHistory.length})`);
		lines.push('```json');
		lines.push(truncateDeterministic(JSON.stringify(compactHistory, null, 2), options.maxChars));
		lines.push('```');
		return lines.join('\n');
	}

	// metadata section
	lines.push('## Metadata');
	lines.push('```json');
	lines.push(truncateDeterministic(JSON.stringify(metadata, null, 2), options.maxChars));
	lines.push('```');
	return lines.join('\n');
}

/**
 * Task read tools (discovery + retrieval)
 */
export function registerTaskReadTools(server: McpServer): void {
	server.tool(
		'list_tasks',
		'Use when the user asks to see tasks in the active project, optionally filtered by status.',
		{
			status: StatusFilterSchema
				.optional()
				.describe(
					'Comma-separated status filter (e.g. "todo,in_progress"). Default: "todo,in_progress,in_review". Options: todo, in_progress, in_review, done, backlog, frozen'
					)
			},
			{
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true
			},
			async ({ status }, extra) => {
			const startedAt = Date.now();
			try {
				const config = requireProject();
				const projectId = config.currentProjectId;
				if (!projectId) throw new Error('NO_ACTIVE_PROJECT: No project selected.');
				const statusFilter = status || 'todo,in_progress,in_review';
				const data = await fetchTasksByStatus(projectId, statusFilter);

				if (data.length === 0) {
					return {
						content: [{ type: 'text' as const, text: `No tasks found with status: ${statusFilter}` }]
					};
				}

				const statusOrder = ['in_progress', 'in_review', 'todo', 'frozen', 'backlog', 'done'];
				const tasksByStatus: Record<string, TaskResponse[]> = {};

				for (const t of data) {
					if (!tasksByStatus[t.status]) tasksByStatus[t.status] = [];
					tasksByStatus[t.status].push(t);
				}

				const lines: string[] = [`## Tasks in ${config.currentProjectName || 'project'}`, ''];

				for (const s of statusOrder) {
					const tasks = tasksByStatus[s];
					if (tasks && tasks.length > 0) {
						lines.push(`### ${STATUS_ICONS[s] || '⬜'} ${s.replace('_', ' ').toUpperCase()}`);
						for (const t of tasks) {
							const tags = t.tags?.length ? ` [${t.tags.map((tg) => tg.name).join(', ')}]` : '';
							const desc = t.description
								? ` — ${t.description.substring(0, 60)}${t.description.length > 60 ? '...' : ''}`
								: '';
							lines.push(`- **${t.title}** (\`${t.id.substring(0, 5)}\`) · ${t.priority}${tags}${desc}`);
						}
						lines.push('');
					}
				}

				const response = { content: [{ type: 'text' as const, text: lines.join('\n') }] };
				trackToolCall({
					tool: 'list_tasks',
					input: { status: statusFilter },
					output: { count: data.length },
					latencyMs: Date.now() - startedAt,
					sessionId: extra.sessionId,
					prompt: extractPromptFromHeaders(extra.requestInfo?.headers)
				});
				return response;
			} catch (error) {
				trackToolCall({
					tool: 'list_tasks',
					input: { status },
					error: error instanceof Error ? error.message : String(error),
					latencyMs: Date.now() - startedAt,
					sessionId: extra.sessionId,
					prompt: extractPromptFromHeaders(extra.requestInfo?.headers)
				});
				const err = formatApiError(error);
				return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
			}
		}
	);

	server.tool(
		'search_tasks',
		'Use when the user provides free-text intent and you need matching tasks by title or description.',
		{
			query: z.string().trim().min(2).max(120).describe('Search query to match against task titles and descriptions')
		},
		{
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true
		},
		async ({ query }, extra) => {
			const startedAt = Date.now();
			try {
				const config = requireProject();
				const projectId = config.currentProjectId;
				if (!projectId) throw new Error('NO_ACTIVE_PROJECT: No project selected.');
				const api = getApiClient();

				const { data } = await api.get<TaskResponse[]>(
					`/projects/${projectId}/tasks?search=${encodeURIComponent(query)}`
				);

				if (data.length === 0) {
					return {
						content: [{ type: 'text' as const, text: `No tasks found matching "${query}"` }]
					};
				}

				const lines = data.map(
					(t) =>
						`- **${t.title}** (\`${t.id.substring(0, 5)}\`) · ${STATUS_ICONS[t.status] || ''} ${t.status} · ${t.priority}`
				);

				const response = {
					content: [
						{
							type: 'text' as const,
							text: `## Search results for "${query}"\n\n${lines.join('\n')}`
						}
					]
				};
				trackToolCall({
					tool: 'search_tasks',
					input: { query },
					output: { count: data.length },
					latencyMs: Date.now() - startedAt,
					sessionId: extra.sessionId,
					prompt: extractPromptFromHeaders(extra.requestInfo?.headers)
				});
				return response;
			} catch (error) {
				trackToolCall({
					tool: 'search_tasks',
					input: { query },
					error: error instanceof Error ? error.message : String(error),
					latencyMs: Date.now() - startedAt,
					sessionId: extra.sessionId,
					prompt: extractPromptFromHeaders(extra.requestInfo?.headers)
				});
				const err = formatApiError(error);
				return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
			}
		}
	);

	server.tool(
		'get_task_context_compact',
		'Use when the user asks to work on a task and you need a token-efficient context snapshot first.',
		{
			taskId: TaskIdentifierSchema.describe('Task ID (full UUID or truncated prefix like "22b50")'),
			historyLimit: z
				.number()
				.int()
				.min(1)
				.max(MAX_HISTORY_LIMIT)
				.optional()
				.describe('Max history entries to include (default: 3)'),
			maxChars: z
				.number()
				.int()
				.min(500)
				.max(MAX_ALLOWED_CHARS)
				.optional()
					.describe('Max chars for long text fields (default: 3500)')
		},
		{
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true
		},
		async ({ taskId, historyLimit, maxChars }) => {
			try {
				const config = requireProject();
				const projectId = config.currentProjectId;
				if (!projectId) throw new Error('NO_ACTIVE_PROJECT: No project selected.');
				const api = getApiClient();
				const task = await resolveTaskByIdentifier(api, projectId, taskId);
				await updateTaskLastRetrievedAt(api, projectId, task);

				const options: CompactOptions = {
					historyLimit: clampNumber(historyLimit, DEFAULT_HISTORY_LIMIT, 1, MAX_HISTORY_LIMIT),
					maxChars: clampNumber(maxChars, DEFAULT_MAX_CHARS, 500, MAX_ALLOWED_CHARS)
				};

				return {
					content: [{ type: 'text' as const, text: renderCompactContext(task, options) }]
				};
			} catch (error) {
				const err = formatApiError(error);
				return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
			}
		}
	);

	server.tool(
		'get_task_context_full',
		'Use when compact context is not enough and the user needs full task details including full plan/walkthrough.',
		{
			taskId: TaskIdentifierSchema.describe('Task ID (full UUID or truncated prefix like "22b50")')
		},
		{
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true
		},
		async ({ taskId }) => {
			try {
				const config = requireProject();
				const projectId = config.currentProjectId;
				if (!projectId) throw new Error('NO_ACTIVE_PROJECT: No project selected.');
				const api = getApiClient();
				const task = await resolveTaskByIdentifier(api, projectId, taskId);
				await updateTaskLastRetrievedAt(api, projectId, task);

				return {
					content: [{ type: 'text' as const, text: renderFullContext(task) }]
				};
			} catch (error) {
				const err = formatApiError(error);
				return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
			}
		}
	);

	server.tool(
		'get_task_section',
		'Use when the user only needs one part of the task context (plan, walkthrough, metadata, or history).',
		{
			taskId: TaskIdentifierSchema.describe('Task ID (full UUID or truncated prefix like "22b50")'),
			section: SectionSchema.describe('Section to retrieve: plan | walkthrough | metadata | history'),
			historyLimit: z
				.number()
				.int()
				.min(1)
				.max(MAX_HISTORY_LIMIT)
				.optional()
				.describe('Max history entries when section=history (default: 3)'),
			maxChars: z
				.number()
				.int()
				.min(500)
				.max(MAX_ALLOWED_CHARS)
				.optional()
					.describe('Max chars for section payload (default: 3500)')
		},
		{
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true
		},
		async ({ taskId, section, historyLimit, maxChars }) => {
			try {
				const config = requireProject();
				const projectId = config.currentProjectId;
				if (!projectId) throw new Error('NO_ACTIVE_PROJECT: No project selected.');
				const api = getApiClient();
				const task = await resolveTaskByIdentifier(api, projectId, taskId);
				await updateTaskLastRetrievedAt(api, projectId, task);

				const options: CompactOptions = {
					historyLimit: clampNumber(historyLimit, DEFAULT_HISTORY_LIMIT, 1, MAX_HISTORY_LIMIT),
					maxChars: clampNumber(maxChars, DEFAULT_MAX_CHARS, 500, MAX_ALLOWED_CHARS)
				};

				return {
					content: [{ type: 'text' as const, text: renderTaskSection(task, section, options) }]
				};
			} catch (error) {
				const err = formatApiError(error);
				return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
			}
		}
	);

	server.tool(
		'get_active_tasks',
		'Use when the user asks for active work items (todo, in_progress, in_review) without custom filtering.',
		{},
		{
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true
		},
		async () => {
			try {
				const config = requireProject();
				const projectId = config.currentProjectId;
				if (!projectId) throw new Error('NO_ACTIVE_PROJECT: No project selected.');
				const data = await fetchTasksByStatus(projectId, 'todo,in_progress,in_review');
				if (data.length === 0) {
					return { content: [{ type: 'text' as const, text: 'No active tasks found.' }] };
				}
				const lines = data.map((t) => `- **${t.title}** (\`${t.id.substring(0, 5)}\`) · ${t.status} · ${t.priority}`);
				return { content: [{ type: 'text' as const, text: `## Active Tasks\n\n${lines.join('\n')}` }] };
			} catch (error) {
				const err = formatApiError(error);
				return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
			}
		}
	);

	server.tool(
		'get_tasks_in_review',
		'Use when the user asks specifically for tasks waiting in review.',
		{},
		{
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true
		},
		async () => {
			try {
				const config = requireProject();
				const projectId = config.currentProjectId;
				if (!projectId) throw new Error('NO_ACTIVE_PROJECT: No project selected.');
				const data = await fetchTasksByStatus(projectId, 'in_review');
				if (data.length === 0) {
					return { content: [{ type: 'text' as const, text: 'No in_review tasks found.' }] };
				}
				const lines = data.map((t) => `- **${t.title}** (\`${t.id.substring(0, 5)}\`) · ${t.priority}`);
				return { content: [{ type: 'text' as const, text: `## Tasks in Review\n\n${lines.join('\n')}` }] };
			} catch (error) {
				const err = formatApiError(error);
				return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
			}
		}
	);
}

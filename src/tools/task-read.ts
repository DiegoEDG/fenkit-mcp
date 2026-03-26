import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { requireProject } from '../config.js';
import { getApiClient, formatApiError } from '../api.js';
import { stripPrivate, stripPrivateDeep, truncateDeterministic } from '../utils.js';
import { resolveTaskByIdentifier, updateTaskLastRetrievedAt, type TaskResponse } from './task-common.js';

const STATUS_ICONS: Record<string, string> = {
	todo: '📋',
	in_progress: '🏗️',
	done: '✅',
	backlog: '📥',
	frozen: '❄️'
};

const SectionSchema = z.enum(['plan', 'walkthrough', 'metadata', 'history']);
const ModeSchema = z.enum(['compact', 'full']);

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

function compactExecution(execution: unknown): Record<string, unknown> | null {
	if (!isRecord(execution)) return null;
	return {
		timestamp: execution.timestamp,
		model: execution.model,
		agent: execution.agent,
		provider: execution.provider,
		durationMs: execution.durationMs,
		tokens: isRecord(execution.tokens)
			? { estimate: execution.tokens.estimate, total: execution.tokens.total }
			: undefined
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
		'List tasks in the active project. Returns task titles, IDs, status, and priority. Use status filter to narrow results. Default shows todo + in_progress tasks.',
		{
			status: z
				.string()
				.optional()
				.describe(
					'Comma-separated status filter (e.g. "todo,in_progress"). Default: "todo,in_progress". Options: todo, in_progress, done, backlog, frozen'
				)
		},
		async ({ status }) => {
			try {
				const config = requireProject();
				const projectId = config.currentProjectId;
				if (!projectId) throw new Error('NO_ACTIVE_PROJECT: No project selected.');
				const api = getApiClient();
				const params = new URLSearchParams();
				const statusFilter = status || 'todo,in_progress';
				params.set('status', statusFilter);

				const { data } = await api.get<TaskResponse[]>(
					`/projects/${projectId}/tasks?${params.toString()}`
				);

				if (data.length === 0) {
					return {
						content: [{ type: 'text' as const, text: `No tasks found with status: ${statusFilter}` }]
					};
				}

				const statusOrder = ['in_progress', 'todo', 'frozen', 'backlog', 'done'];
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

				return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
			} catch (error) {
				const err = formatApiError(error);
				return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
			}
		}
	);

	server.tool(
		'search_tasks',
		'Search tasks by name or description in the active project. Returns matching tasks with their IDs and status.',
		{
			query: z.string().describe('Search query to match against task titles and descriptions')
		},
		async ({ query }) => {
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

				return {
					content: [
						{
							type: 'text' as const,
							text: `## Search results for "${query}"\n\n${lines.join('\n')}`
						}
					]
				};
			} catch (error) {
				const err = formatApiError(error);
				return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
			}
		}
	);

	server.tool(
		'get_task_context_compact',
		'Primary retrieval tool for LLM agents. Returns compact task context optimized for tokens. Use this first, then call `get_task_context_full` or `get_task_section` only if needed.',
		{
			taskId: z.string().describe('Task ID (full UUID or truncated prefix like "22b50")'),
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
		'Returns complete task context (description, full plan/walkthrough, full metadata). Use only when compact context is insufficient.',
		{
			taskId: z.string().describe('Task ID (full UUID or truncated prefix like "22b50")')
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
		'Returns only one section of a task (`plan`, `walkthrough`, `metadata`, or `history`) with output caps. Use after compact retrieval to reduce token usage.',
		{
			taskId: z.string().describe('Task ID (full UUID or truncated prefix like "22b50")'),
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

	// Backward-compatible alias (deprecated)
	server.tool(
		'get_full_task',
		'[Deprecated alias] Use `get_task_context_compact` first. This alias supports mode=compact|full and optional section.',
		{
			taskId: z.string().describe('Task ID (full UUID or truncated prefix like "22b50")'),
			mode: ModeSchema.optional().describe('compact (default) or full'),
			section: SectionSchema.optional().describe('Optional section override: plan|walkthrough|metadata|history'),
			historyLimit: z
				.number()
				.int()
				.min(1)
				.max(MAX_HISTORY_LIMIT)
				.optional()
				.describe('History entries cap (default: 3)'),
			maxChars: z
				.number()
				.int()
				.min(500)
				.max(MAX_ALLOWED_CHARS)
				.optional()
				.describe('Text cap for compact/section output')
		},
		async ({ taskId, mode, section, historyLimit, maxChars }) => {
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

				let content: string;
				if (section) {
					content = renderTaskSection(task, section, options);
				} else if (mode === 'full') {
					content = renderFullContext(task);
				} else {
					content = renderCompactContext(task, options);
				}

				const notice =
					'> Deprecated: prefer `get_task_context_compact`, `get_task_context_full`, or `get_task_section`.\n\n';
				return { content: [{ type: 'text' as const, text: `${notice}${content}` }] };
			} catch (error) {
				const err = formatApiError(error);
				return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
			}
		}
	);
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { requireProject } from '../config.js';
import { getApiClient, formatApiError } from '../api.js';
import { resolveTaskByIdentifier, type TaskResponse } from './task-common.js';
import { TaskIdentifierSchema } from '../schemas.js';
import { extractPromptFromHeaders, trackToolCall } from '../observability.js';
import { clampMaxChars, MAX_ALLOWED_CHARS } from '../compact-context.js';
import {
	renderCompactContext,
	renderFullContext,
	renderTaskSection,
	STATUS_ICONS,
	SectionSchema
} from '../task-context-render.js';
const StatusFilterSchema = z
	.string()
	.trim()
	.min(1)
	.max(120)
	.regex(/^[a-z_,]+$/i, 'Status filter must be comma-separated lowercase values');

const CHAT_ID_HEADER_KEYS = ['x-chat-id'] as const;

interface ResolveSessionResponse {
	state: 'bound' | 'unbound' | 'needs_confirmation';
	project_id?: string;
	task_id?: string;
	reason?: string;
	status?: string;
	last_tool?: string;
	last_seen_at?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getHeaderString(headers: unknown, keys: readonly string[]): string | undefined {
	if (!isRecord(headers)) return undefined;
	for (const key of keys) {
		const direct = headers[key];
		if (typeof direct === 'string' && direct.trim().length > 0) return direct.trim();
		if (Array.isArray(direct)) {
			const found = direct.find((value) => typeof value === 'string' && value.trim().length > 0);
			if (typeof found === 'string') return found.trim();
		}
	}
	const lowered = Object.entries(headers).reduce<Record<string, unknown>>((acc, [key, value]) => {
		acc[key.toLowerCase()] = value;
		return acc;
	}, {});
	for (const key of keys) {
		const fromLower = lowered[key.toLowerCase()];
		if (typeof fromLower === 'string' && fromLower.trim().length > 0) return fromLower.trim();
		if (Array.isArray(fromLower)) {
			const found = fromLower.find((value) => typeof value === 'string' && value.trim().length > 0);
			if (typeof found === 'string') return found.trim();
		}
	}
	return undefined;
}

async function syncChatTaskBindingHeartbeat(options: {
	projectId: string;
	task: TaskResponse;
	tool: string;
	chatId?: string;
	headers?: unknown;
}): Promise<void> {
	const chatId = options.chatId ?? getHeaderString(options.headers, CHAT_ID_HEADER_KEYS);
	if (!chatId) return;
	const api = getApiClient();
	await api.post('/mcp/task-sessions/heartbeat', {
		session_id: `${chatId}_${options.task.id}`,
		chat_id: chatId,
		project_id: options.projectId,
		task_id: options.task.id,
		last_tool: options.tool,
		last_seen_at: new Date().toISOString(),
		status: options.task.status
	});
}

async function fetchTasksByStatus(projectId: string, statusFilter: string): Promise<TaskResponse[]> {
	const api = getApiClient();
	const params = new URLSearchParams();
	params.set('status', statusFilter);
	const { data } = await api.get<TaskResponse[]>(`/projects/${projectId}/tasks?${params.toString()}`);
	return data;
}

/**
 * Task read tools (discovery + retrieval)
 */
export function registerTaskReadTools(server: McpServer): void {
	server.tool(
		'resolve_session_task',
		'Use at chat/session start to deterministically resolve the active task bound to this chat_id.',
		{
			chat_id: z.string().trim().min(1).max(120).describe('Chat/thread identifier used as deterministic binding key'),
			maxChars: z
				.number()
				.int()
				.min(500)
				.max(MAX_ALLOWED_CHARS)
				.optional()
				.describe('Max chars for compact context fields when state=bound')
		},
		{
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true
		},
		async ({ chat_id, maxChars }, extra) => {
			const startedAt = Date.now();
			try {
				if (!chat_id?.trim()) {
					return {
						content: [
							{
								type: 'text' as const,
								text: 'CHAT_ID_REQUIRED: resolve_session_task requires a non-empty chat_id. Explicitly select a task and bind it via normal task tools once chat_id is available.'
							}
						],
						isError: true
					};
				}

				const api = getApiClient();
				const { data } = await api.get<ResolveSessionResponse>('/mcp/task-sessions/resolve', {
					params: { chat_id }
				});

				if (data.state === 'unbound') {
					trackToolCall({
						tool: 'resolve_session_task',
						input: { chat_id },
						output: { state: 'unbound' },
						latencyMs: Date.now() - startedAt,
						sessionId: extra.sessionId,
						chatId: chat_id,
						prompt: extractPromptFromHeaders(extra.requestInfo?.headers)
					});
					return {
						content: [
							{ type: 'text' as const, text: `## Chat Task Resolution\n\n- state: unbound\n- chat_id: ${chat_id}` }
						]
					};
				}

				if (data.state === 'needs_confirmation') {
					trackToolCall({
						tool: 'resolve_session_task',
						input: { chat_id },
						output: { state: 'needs_confirmation', reason: data.reason },
						latencyMs: Date.now() - startedAt,
						sessionId: extra.sessionId,
						chatId: chat_id,
						prompt: extractPromptFromHeaders(extra.requestInfo?.headers)
					});
					return {
						content: [
							{
								type: 'text' as const,
								text: `## Chat Task Resolution\n\n- state: needs_confirmation\n- reason: ${data.reason || 'unknown'}\n- project_id: ${data.project_id || 'n/a'}\n- task_id: ${data.task_id || 'n/a'}`
							}
						]
					};
				}

				if (!data.project_id || !data.task_id) {
					throw new Error('INVALID_RESOLVE_PAYLOAD: state=bound requires project_id and task_id.');
				}

				const { data: task } = await api.get<TaskResponse>(`/projects/${data.project_id}/tasks/${data.task_id}`);
				await syncChatTaskBindingHeartbeat({
					projectId: data.project_id,
					task,
					tool: 'resolve_session_task',
					chatId: chat_id,
					headers: extra.requestInfo?.headers
				});

				try {
					const { data: projects } = await api.get<Array<{ id: string; name: string }>>('/projects');
					const resolvedProject = projects.find((project) => project.id === data.project_id);
					saveConfig({
						currentProjectId: data.project_id,
						currentProjectName: resolvedProject?.name
					});
				} catch {
					saveConfig({ currentProjectId: data.project_id });
				}

				const options: CompactOptions = {
					maxChars: clampNumber(maxChars, DEFAULT_MAX_CHARS, 500, MAX_ALLOWED_CHARS)
				};
				const compact = renderCompactContext(task, options);
				trackToolCall({
					tool: 'resolve_session_task',
					input: { chat_id },
					output: { state: 'bound', project_id: data.project_id, task_id: data.task_id },
					latencyMs: Date.now() - startedAt,
					sessionId: extra.sessionId,
					chatId: chat_id,
					prompt: extractPromptFromHeaders(extra.requestInfo?.headers)
				});
				return {
					content: [
						{
							type: 'text' as const,
							text: `## Chat Task Resolution\n\n- state: bound\n- chat_id: ${chat_id}\n- project_id: ${data.project_id}\n- task_id: ${data.task_id}\n\n${compact}`
						}
					]
				};
			} catch (error) {
				trackToolCall({
					tool: 'resolve_session_task',
					input: { chat_id },
					error: error instanceof Error ? error.message : String(error),
					latencyMs: Date.now() - startedAt,
					sessionId: extra.sessionId,
					chatId: chat_id,
					prompt: extractPromptFromHeaders(extra.requestInfo?.headers)
				});
				const err = formatApiError(error);
				return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
			}
		}
	);

	server.tool(
		'list_tasks',
		'Use when the user asks to see tasks in the active project, optionally filtered by status.',
		{
			status: StatusFilterSchema.optional().describe(
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
		async ({ taskId, maxChars }, extra) => {
			try {
				const config = requireProject();
				const projectId = config.currentProjectId;
				if (!projectId) throw new Error('NO_ACTIVE_PROJECT: No project selected.');
				const api = getApiClient();
				const task = await resolveTaskByIdentifier(api, projectId, taskId);
				await syncChatTaskBindingHeartbeat({
					projectId,
					task,
					tool: 'get_task_context_compact',
					headers: extra.requestInfo?.headers
				});

				const options: CompactOptions = {
					maxChars: clampMaxChars(maxChars)
				};

				return {
					content: [{ type: 'text' as const, text: renderCompactContext(task, options.maxChars) }]
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
		async ({ taskId }, extra) => {
			try {
				const config = requireProject();
				const projectId = config.currentProjectId;
				if (!projectId) throw new Error('NO_ACTIVE_PROJECT: No project selected.');
				const api = getApiClient();
				const task = await resolveTaskByIdentifier(api, projectId, taskId);
				await syncChatTaskBindingHeartbeat({
					projectId,
					task,
					tool: 'get_task_context_full',
					headers: extra.requestInfo?.headers
				});

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
		'Use when the user only needs one part of the task context (plan, walkthrough, or mcp_context).',
		{
			taskId: TaskIdentifierSchema.describe('Task ID (full UUID or truncated prefix like "22b50")'),
			section: SectionSchema.describe('Section to retrieve: plan | walkthrough | mcp_context'),
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
		async ({ taskId, section, maxChars }, extra) => {
			try {
				const config = requireProject();
				const projectId = config.currentProjectId;
				if (!projectId) throw new Error('NO_ACTIVE_PROJECT: No project selected.');
				const api = getApiClient();
				const task = await resolveTaskByIdentifier(api, projectId, taskId);
				await syncChatTaskBindingHeartbeat({
					projectId,
					task,
					tool: 'get_task_section',
					headers: extra.requestInfo?.headers
				});

				const options = { maxChars: clampMaxChars(maxChars) };

				return {
					content: [{ type: 'text' as const, text: renderTaskSection(task, section, options.maxChars) }]
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

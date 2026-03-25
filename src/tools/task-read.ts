import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { requireProject } from '../config.js';
import { getApiClient, formatApiError } from '../api.js';
import { stripPrivate } from '../utils.js';

interface TaskResponse {
	id: string;
	projectId: string;
	title: string;
	description?: string | null;
	status: string;
	priority: string;
	assigneeId?: string | null;
	plan?: string | null;
	walkthrough?: string | null;
	implementationMetadata?: Record<string, unknown> | null;
	createdBy: string;
	updatedBy?: string | null;
	createdAt: string;
	updatedAt: string;
	tags?: { id: string; name: string; color: string | null }[];
}

const STATUS_ICONS: Record<string, string> = {
	todo: '📋',
	in_progress: '🏗️',
	done: '✅',
	backlog: '📥',
	frozen: '❄️'
};

/**
 * Phase 1: Task read tools (discovery + retrieval)
 * PRD Sections 6.2, 6.3
 */
export function registerTaskReadTools(server: McpServer): void {
	// list_tasks — GET /projects/:projectId/tasks
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
				const api = getApiClient();
				const params = new URLSearchParams();
				const statusFilter = status || 'todo,in_progress';
				params.set('status', statusFilter);

				const { data } = await api.get<TaskResponse[]>(
					`/projects/${config.currentProjectId}/tasks?${params.toString()}`
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

	// search_tasks — GET /projects/:projectId/tasks?search=
	server.tool(
		'search_tasks',
		'Search tasks by name or description in the active project. Returns matching tasks with their IDs and status.',
		{
			query: z.string().describe('Search query to match against task titles and descriptions')
		},
		async ({ query }) => {
			try {
				const config = requireProject();
				const api = getApiClient();

				const { data } = await api.get<TaskResponse[]>(
					`/projects/${config.currentProjectId}/tasks?search=${encodeURIComponent(query)}`
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

	// get_full_task — Full task context retrieval
	// PRD 6.3: Returns full task context in one retrieval
	server.tool(
		'get_full_task',
		'Retrieve the full context of a task including description, plan, walkthrough, metadata, and history — all in one call. This is the primary tool for understanding a task before starting work. Supports both full UUIDs and truncated IDs.',
		{
			taskId: z.string().describe('Task ID (full UUID or truncated prefix like "22b50")')
		},
		async ({ taskId }) => {
			try {
				const config = requireProject();
				const api = getApiClient();

				let taskData: TaskResponse;

				const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId);

				if (isUuid) {
					const { data } = await api.get<TaskResponse>(`/projects/${config.currentProjectId}/tasks/${taskId}`);
					taskData = data;
				} else {
					// Fuzzy search by name or truncated ID
					const { data } = await api.get<TaskResponse[]>(
						`/projects/${config.currentProjectId}/tasks?search=${encodeURIComponent(taskId)}`
					);

					if (data.length === 0) {
						return {
							content: [
								{
									type: 'text' as const,
									text: `No task found matching "${taskId}". Use \`list_tasks\` or \`search_tasks\` to find the right task.`
								}
							],
							isError: true
						};
					}

					taskData = data[0];
				}

				// Record retrieval timestamp for duration tracking
				const existingMetadata = (taskData.implementationMetadata as Record<string, unknown>) || {};
				await api.patch(`/projects/${config.currentProjectId}/tasks/${taskData.id}`, {
					implementationMetadata: {
						...existingMetadata,
						lastRetrievedAt: new Date().toISOString()
					}
				});

				// Build comprehensive markdown context
				const sections: string[] = [];
				sections.push(`# ${taskData.title}`);
				sections.push('');
				sections.push(
					`**ID**: \`${taskData.id}\` · **Status**: ${STATUS_ICONS[taskData.status] || ''} ${taskData.status} · **Priority**: ${taskData.priority}`
				);

				if (taskData.tags?.length) {
					sections.push(`**Tags**: ${taskData.tags.map((t) => t.name).join(', ')}`);
				}

				// Description
				sections.push('## Description');
				sections.push(taskData.description ? stripPrivate(taskData.description) : '_(no description)_');
				sections.push('');

				// Plan
				if (taskData.plan) {
					sections.push('## Plan');
					sections.push(stripPrivate(taskData.plan));
					sections.push('');
				}

				// Walkthrough (included for rework context — PRD 7.5)
				if (taskData.walkthrough) {
					sections.push('## Walkthrough');
					sections.push(stripPrivate(taskData.walkthrough));
					sections.push('');
				}

				// Implementation Metadata
				if (taskData.implementationMetadata) {
					const meta = taskData.implementationMetadata;
					sections.push('## Implementation Metadata');
					sections.push('```json');
					sections.push(JSON.stringify(meta, null, 2));
					sections.push('```');
					sections.push('');
				}

				return { content: [{ type: 'text' as const, text: sections.join('\n') }] };
			} catch (error) {
				const err = formatApiError(error);
				return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
			}
		}
	);
}

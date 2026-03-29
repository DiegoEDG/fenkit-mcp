import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { requireProject } from '../config.js';
import { getApiClient, formatApiError } from '../api.js';
import { resolveTaskByIdentifier, type TaskResponse } from '../tools/task-common.js';
import { getToolMetricsSnapshot } from '../observability.js';
import { clampMaxChars } from '../compact-context.js';
import { renderCompactContext, renderTaskLifecycle, renderTaskSection, SectionSchema } from '../task-context-render.js';

function renderTaskList(title: string, tasks: TaskResponse[]): string {
	if (tasks.length === 0) return `## ${title}\n\nNo tasks found.`;
	const lines = tasks.map(
		(task) =>
			`- **${task.title}** (\`${task.id.substring(0, 5)}\`) · ${task.status} · ${task.priority}`
	);
	return `## ${title}\n\n${lines.join('\n')}`;
}

async function getTasks(status: string): Promise<TaskResponse[]> {
	const config = requireProject();
	const projectId = config.currentProjectId;
	if (!projectId) throw new Error('NO_ACTIVE_PROJECT: No project selected.');
	const api = getApiClient();
	const params = new URLSearchParams();
	params.set('status', status);
	const { data } = await api.get<TaskResponse[]>(`/projects/${projectId}/tasks?${params.toString()}`);
	return data;
}

export function registerContextResources(server: McpServer): void {
	server.registerResource(
		'active_tasks_context',
		'fenkit://context/tasks/active',
		{
			description: 'Deterministic context resource with active tasks (todo, in_progress, in_review)',
			mimeType: 'text/markdown'
		},
		async () => {
			try {
				const tasks = await getTasks('todo,in_progress,in_review');
				return {
					contents: [{ uri: 'fenkit://context/tasks/active', mimeType: 'text/markdown', text: renderTaskList('Active Tasks', tasks) }]
				};
			} catch (error) {
				const err = formatApiError(error);
				return {
					contents: [{ uri: 'fenkit://context/tasks/active', mimeType: 'text/plain', text: `Error: ${err.message}` }]
				};
			}
		}
	);

	server.registerResource(
		'review_tasks_context',
		'fenkit://context/tasks/in-review',
		{
			description: 'Deterministic context resource with only tasks in review',
			mimeType: 'text/markdown'
		},
		async () => {
			try {
				const tasks = await getTasks('in_review');
				return {
					contents: [{ uri: 'fenkit://context/tasks/in-review', mimeType: 'text/markdown', text: renderTaskList('Tasks in Review', tasks) }]
				};
			} catch (error) {
				const err = formatApiError(error);
				return {
					contents: [{ uri: 'fenkit://context/tasks/in-review', mimeType: 'text/plain', text: `Error: ${err.message}` }]
				};
			}
		}
	);

	server.registerResource(
		'task_compact_template',
		new ResourceTemplate('fenkit://task/{taskId}/compact', { list: undefined }),
		{
			description: 'Compact-first task context resource for a specific task',
			mimeType: 'text/markdown'
		},
		async (uri, variables) => {
			try {
				const config = requireProject();
				const taskId = String(variables.taskId || '').trim();
				const maxCharsRaw = uri.searchParams.get('maxChars');
				const maxChars = clampMaxChars(maxCharsRaw ? Number(maxCharsRaw) : undefined);
				const api = getApiClient();
				const task = await resolveTaskByIdentifier(api, config.currentProjectId!, taskId);
				return {
					contents: [
						{
							uri: uri.toString(),
							mimeType: 'text/markdown',
							text: renderCompactContext(task, maxChars)
						}
					]
				};
			} catch (error) {
				const err = formatApiError(error);
				return {
					contents: [{ uri: uri.toString(), mimeType: 'text/plain', text: `Error: ${err.message}` }]
				};
			}
		}
	);

	server.registerResource(
		'task_section_template',
		new ResourceTemplate('fenkit://task/{taskId}/section/{section}', { list: undefined }),
		{
			description: 'Focused task section resource (plan, walkthrough, mcp_context)',
			mimeType: 'text/markdown'
		},
		async (uri, variables) => {
			try {
				const config = requireProject();
				const taskId = String(variables.taskId || '').trim();
				const sectionInput = String(variables.section || '').trim();
				const section = SectionSchema.parse(sectionInput);
				const maxCharsRaw = uri.searchParams.get('maxChars');
				const maxChars = clampMaxChars(maxCharsRaw ? Number(maxCharsRaw) : undefined);
				const api = getApiClient();
				const task = await resolveTaskByIdentifier(api, config.currentProjectId!, taskId);
				return {
					contents: [
						{
							uri: uri.toString(),
							mimeType: 'text/markdown',
							text: renderTaskSection(task, section, maxChars)
						}
					]
				};
			} catch (error) {
				const err = formatApiError(error);
				return {
					contents: [{ uri: uri.toString(), mimeType: 'text/plain', text: `Error: ${err.message}` }]
				};
			}
		}
	);

	server.registerResource(
		'task_lifecycle_template',
		new ResourceTemplate('fenkit://task/{taskId}/lifecycle', { list: undefined }),
		{
			description: 'Lifecycle snapshot for task status and latest MCP execution markers',
			mimeType: 'text/markdown'
		},
		async (uri, variables) => {
			try {
				const config = requireProject();
				const taskId = String(variables.taskId || '').trim();
				const api = getApiClient();
				const task = await resolveTaskByIdentifier(api, config.currentProjectId!, taskId);
				return {
					contents: [
						{
							uri: uri.toString(),
							mimeType: 'text/markdown',
							text: renderTaskLifecycle(task)
						}
					]
				};
			} catch (error) {
				const err = formatApiError(error);
				return {
					contents: [{ uri: uri.toString(), mimeType: 'text/plain', text: `Error: ${err.message}` }]
				};
			}
		}
	);

	server.registerResource(
		'observability_summary',
		'fenkit://context/observability/summary',
		{
			description: 'Live MCP tool-call metrics snapshot for autoinvoke diagnostics',
			mimeType: 'application/json'
		},
		async () => {
			return {
				contents: [
					{
						uri: 'fenkit://context/observability/summary',
						mimeType: 'application/json',
						text: JSON.stringify(getToolMetricsSnapshot(), null, 2)
					}
				]
			};
		}
	);
}

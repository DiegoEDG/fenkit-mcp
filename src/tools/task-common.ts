import type { AxiosInstance } from 'axios';

export interface TaskResponse {
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
	mcpContext?: Record<string, unknown> | null;
	createdBy: string;
	updatedBy?: string | null;
	createdAt: string;
	updatedAt: string;
	tags?: { id: string; name: string; color: string | null }[];
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
	return UUID_REGEX.test(value);
}

export async function resolveTaskByIdentifier(
	api: AxiosInstance,
	projectId: string,
	identifier: string
): Promise<TaskResponse> {
	if (isUuid(identifier)) {
		const { data } = await api.get<TaskResponse>(`/projects/${projectId}/tasks/${identifier}`);
		return data;
	}

	const { data } = await api.get<TaskResponse[]>(
		`/projects/${projectId}/tasks?search=${encodeURIComponent(identifier)}`
	);

	if (data.length === 0) {
		throw new Error(
			`TASK_NOT_FOUND: No task found matching "${identifier}". Use \`list_tasks\` or \`search_tasks\` first.`
		);
	}

	const normalized = identifier.toLowerCase();
	const prefixMatches = data.filter((task) => task.id.toLowerCase().startsWith(normalized));

	if (prefixMatches.length === 1) {
		return prefixMatches[0];
	}

	if (prefixMatches.length > 1) {
		const candidates = prefixMatches
			.slice(0, 5)
			.map((task) => `\`${task.id.substring(0, 5)}\` ${task.title}`)
			.join(', ');
		throw new Error(`AMBIGUOUS_TASK_ID: Multiple tasks match "${identifier}": ${candidates}`);
	}

	if (data.length === 1) {
		return data[0];
	}

	const candidates = data
		.slice(0, 5)
		.map((task) => `\`${task.id.substring(0, 5)}\` ${task.title}`)
		.join(', ');
	throw new Error(`AMBIGUOUS_TASK_ID: Multiple tasks match "${identifier}": ${candidates}`);
}

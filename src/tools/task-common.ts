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
	mcpContext?: Record<string, unknown> | null;
	createdBy: string;
	updatedBy?: string | null;
	createdAt: string;
	updatedAt: string;
	tags?: { id: string; name: string; color: string | null }[];
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FALLBACK_STATUS_FILTER = 'todo,in_progress,in_review,backlog,frozen,done';

export function isUuid(value: string): boolean {
	return UUID_REGEX.test(value);
}

export async function resolveTaskByIdentifier(
	api: AxiosInstance,
	projectId: string,
	identifier: string
): Promise<TaskResponse> {
	const normalized = identifier.toLowerCase();

	if (isUuid(identifier)) {
		const { data } = await api.get<TaskResponse>(`/projects/${projectId}/tasks/${identifier}`);
		return data;
	}

	// Fast path: try direct lookup first (works when backend supports prefix IDs)
	try {
		const { data } = await api.get<TaskResponse>(`/projects/${projectId}/tasks/${identifier}`);
		return data;
	} catch {
		// Continue with fallback strategies below.
	}

	const { data } = await api.get<TaskResponse[]>(
		`/projects/${projectId}/tasks?search=${encodeURIComponent(identifier)}`
	);

	if (data.length === 0) {
		const { data: allTasks } = await api.get<TaskResponse[]>(
			`/projects/${projectId}/tasks?status=${encodeURIComponent(FALLBACK_STATUS_FILTER)}`
		);

		const fallbackMatches = allTasks.filter((task) =>
			task.id.toLowerCase().startsWith(normalized)
		);

		if (fallbackMatches.length === 1) {
			return fallbackMatches[0]!;
		}

		if (fallbackMatches.length > 1) {
			const candidates = fallbackMatches
				.slice(0, 5)
				.map((task) => `\`${task.id.substring(0, 5)}\` ${task.title}`)
				.join(', ');
			throw new Error(`AMBIGUOUS_TASK_ID: Multiple tasks match "${identifier}": ${candidates}`);
		}

		throw new Error(
			`TASK_NOT_FOUND: No task found matching "${identifier}". Use \`list_tasks\` or \`search_tasks\` first.`
		);
	}
	const prefixMatches = data.filter((task) => task.id.toLowerCase().startsWith(normalized));

	if (prefixMatches.length === 1) {
		return prefixMatches[0]!;
	}

	if (prefixMatches.length > 1) {
		const candidates = prefixMatches
			.slice(0, 5)
			.map((task) => `\`${task.id.substring(0, 5)}\` ${task.title}`)
			.join(', ');
		throw new Error(`AMBIGUOUS_TASK_ID: Multiple tasks match "${identifier}": ${candidates}`);
	}

	if (data.length === 1) {
		return data[0]!;
	}

	const candidates = data
		.slice(0, 5)
		.map((task) => `\`${task.id.substring(0, 5)}\` ${task.title}`)
		.join(', ');
	throw new Error(`AMBIGUOUS_TASK_ID: Multiple tasks match "${identifier}": ${candidates}`);
}

export async function resolveTaskIdentifiers(
	api: AxiosInstance,
	projectId: string,
	identifiers: string[]
): Promise<string[]> {
	if (identifiers.length === 0) return [];

	const cache = new Map<string, string>();
	const resolved: string[] = [];

	for (const identifier of identifiers) {
		const normalized = identifier.trim().toLowerCase();
		const cached = cache.get(normalized);
		if (cached) {
			resolved.push(cached);
			continue;
		}

		const task = await resolveTaskByIdentifier(api, projectId, identifier);
		cache.set(normalized, task.id);
		resolved.push(task.id);
	}

	return resolved;
}

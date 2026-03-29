export type ToolCapability = 'read' | 'write' | 'admin';

export const TOOL_CAPABILITIES: Record<string, ToolCapability> = {
	// auth
	login: 'admin',
	get_status: 'read',

	// projects
	list_projects: 'read',
	get_active_project: 'read',
	select_project: 'write',

	// task read
	resolve_chat_task: 'read',
	list_tasks: 'read',
	search_tasks: 'read',
	get_task_context_compact: 'read',
	get_task_context_full: 'read',
	get_task_section: 'read',
	get_active_tasks: 'read',
	get_tasks_in_review: 'read',

	// task write
	update_task_plan: 'write',
	update_task_walkthrough: 'write',
	set_task_status: 'write',
	set_task_priority: 'write',

	// setup
	setup_client: 'admin',
	get_setup_instructions: 'admin'
};

const READ_TOOLS = new Set(
	Object.entries(TOOL_CAPABILITIES)
		.filter(([, capability]) => capability === 'read')
		.map(([name]) => name)
);
const WRITE_TOOLS = new Set(
	Object.entries(TOOL_CAPABILITIES)
		.filter(([, capability]) => capability === 'write')
		.map(([name]) => name)
);

export function assertToolCapabilityRegistry(): void {
	for (const name of READ_TOOLS) {
		if (WRITE_TOOLS.has(name)) {
			throw new Error(`TOOL_CAPABILITY_REGISTRY_INVALID: "${name}" cannot be both read and write.`);
		}
	}
}

export function getToolsByCapability(capability: ToolCapability): string[] {
	return Object.entries(TOOL_CAPABILITIES)
		.filter(([, value]) => value === capability)
		.map(([name]) => name)
		.sort();
}

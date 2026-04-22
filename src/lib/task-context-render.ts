import { z } from 'zod';
import { compactNarrative } from './compact-context.js';
import { stripPrivate, stripPrivateDeep, truncateDeterministic } from './utils.js';
import type { TaskResponse } from '@tools/task-common.js';

export const STATUS_ICONS: Record<string, string> = {
	todo: '📋',
	in_progress: '🏗️',
	in_review: '🔍',
	done: '✅',
	backlog: '📥',
	frozen: '❄️'
};

export const SectionSchema = z.enum(['plan', 'walkthrough', 'mcp_context']);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function renderCompactContext(task: TaskResponse, maxChars: number): string {
	const context = isRecord(task.mcpContext) ? task.mcpContext : null;

	const sections: string[] = [];
	sections.push(`# ${task.title}`);
	sections.push('');
	sections.push(
		`**ID**: \`${task.id}\` · **Status**: ${STATUS_ICONS[task.status] || ''} ${task.status} · **Priority**: ${task.priority}`
	);
	if (task.tags?.length) {
		sections.push(`**Tags**: ${task.tags.map((t) => t.name).join(', ')}`);
	}

	// Workstream fields for scoped execution
	if (task.workstreamId || task.workstreamTag || task.rootTaskId) {
		sections.push('## Workstream');
		if (task.workstreamId) sections.push(`- **ID**: ${task.workstreamId}`);
		if (task.rootTaskId) sections.push(`- **Root**: ${task.rootTaskId.substring(0, 5)}`);
		if (task.workstreamTag) sections.push(`- **Tag**: ${task.workstreamTag}`);
		sections.push('');
	}

	sections.push('');

	// M1: Dependency visibility section
	if (task.blockedByTaskIds?.length) {
		sections.push('## Dependencies');
		// Show blocked by task IDs
		const blockedByList = task.blockedByTaskIds
			.map((id) => `\`${id.substring(0, 5)}\``)
			.join(', ');
		sections.push(`- **Blocked by**: ${task.blockedByTaskIds.length} task(s) — ${blockedByList}`);
		if (task.blockedReason) {
			sections.push(`- **Blocked reason**: ${task.blockedReason}`);
		}
		sections.push(`- **Ready to start**: ${task.isReadyToStart ? '✅ Yes' : '⏳ No'}`);
		// Show per-blocker status if available
		if (task.dependencyStatus?.length) {
			const doneCount = task.dependencyStatus.filter(
				(d) => d.status === 'done',
			).length;
			sections.push(
				`- **Blocker status**: ${doneCount}/${task.dependencyStatus.length} done`,
			);
		}
		sections.push('');
	}

	// M1: Show blocking tasks in compact context
	if (task.blockingTaskIds?.length) {
		const blockingList = task.blockingTaskIds
			.map((id) => `\`${id.substring(0, 5)}\``)
			.join(', ');
		sections.push(`- **Blocking**: ${task.blockingTaskIds.length} task(s) — ${blockingList}`);
		sections.push('');
	}

	sections.push('## Description (compact)');
	sections.push(compactNarrative(task.description, maxChars) || '_(no description)_');
	sections.push('');

	if (task.plan) {
		sections.push('## Plan Summary');
		sections.push(compactNarrative(task.plan, maxChars));
		sections.push('');
	}

	if (task.walkthrough) {
		sections.push('## Walkthrough Summary');
		sections.push(compactNarrative(task.walkthrough, maxChars));
		sections.push('');
	}

	if (context) {
		sections.push('## Latest Chat Context');
		sections.push(`- Actor: ${String(context.actor || 'n/a')}`);
		sections.push(`- Tool: ${String(context.tool || 'n/a')}`);
		sections.push(`- Chat ID: ${String(context.chat_id || context.last_chat_id || 'n/a')}`);
		sections.push(`- Session ID: ${String(context.session_id || context.last_session_id || 'n/a')}`);
		sections.push(`- Last seen: ${String(context.last_seen_at || 'n/a')}`);
		sections.push('');
	}

	sections.push(
		'> Compact mode intentionally omits full sections. Call `get_task_context_full` or `get_task_section` if needed.'
	);

	return sections.join('\n');
}

export function renderFullContext(task: TaskResponse): string {
	const sections: string[] = [];
	sections.push(`# ${task.title}`);
	sections.push('');
	sections.push(
		`**ID**: \`${task.id}\` · **Status**: ${STATUS_ICONS[task.status] || ''} ${task.status} · **Priority**: ${task.priority}`
	);

	if (task.tags?.length) {
		sections.push(`**Tags**: ${task.tags.map((t) => t.name).join(', ')}`);
	}

	// Workstream fields for scoped execution
	if (task.workstreamId || task.workstreamTag || task.rootTaskId) {
		sections.push('## Workstream');
		if (task.workstreamId) sections.push(`- **ID**: ${task.workstreamId}`);
		if (task.rootTaskId) sections.push(`- **Root**: ${task.rootTaskId.substring(0, 5)}`);
		if (task.workstreamTag) sections.push(`- **Tag**: ${task.workstreamTag}`);
		sections.push('');
	}

	sections.push('');

	// M1: Full dependency visibility section
	if (task.blockedByTaskIds?.length || task.blockingTaskIds?.length) {
		sections.push('## Dependencies');
		sections.push(`- **Is ready to start**: ${task.isReadyToStart ? '✅ Yes' : '⏳ No'}`);
		// Show blocked by task IDs with short IDs
		if (task.blockedByTaskIds?.length) {
			const blockedByList = task.blockedByTaskIds
				.map((id) => `\`${id.substring(0, 5)}\``)
				.join(', ');
			sections.push(
				`- **Blocked by**: ${task.blockedByTaskIds.length} task(s) — ${blockedByList}`,
			);
		} else {
			sections.push(`- **Blocked by**: 0 task(s)`);
		}
		if (task.blockedReason) {
			sections.push(`- **Blocked reason**: ${task.blockedReason}`);
		}
		// Show blocking task IDs with short IDs
		if (task.blockingTaskIds?.length) {
			const blockingList = task.blockingTaskIds
				.map((id) => `\`${id.substring(0, 5)}\``)
				.join(', ');
			sections.push(
				`- **Blocking**: ${task.blockingTaskIds.length} task(s) — ${blockingList}`,
			);
		} else {
			sections.push(`- **Blocking**: 0 task(s)`);
		}
		// Show detailed blocker status if available
		if (task.dependencyStatus?.length) {
			sections.push('');
			sections.push('### Blocker Status');
			for (const dep of task.dependencyStatus) {
				const statusIcon = dep.status === 'done' ? '✅' : '⏳';
				sections.push(`- ${statusIcon} \`${dep.taskId.substring(0, 5)}\` - ${dep.status}`);
			}
		}
		sections.push('');
	}

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

	const context = stripPrivateDeep(task.mcpContext || {});
	if (isRecord(context) && Object.keys(context).length > 0) {
		sections.push('## MCP Context');
		sections.push('```json');
		sections.push(JSON.stringify(context, null, 2));
		sections.push('```');
		sections.push('');
	}

	return sections.join('\n');
}

export function renderTaskSection(
	task: TaskResponse,
	section: z.infer<typeof SectionSchema>,
	maxChars: number
): string {
	const context = stripPrivateDeep(task.mcpContext || {});
	const lines: string[] = [];
	lines.push(`# ${task.title}`);
	lines.push('');
	lines.push(`**ID**: \`${task.id}\``);
	lines.push('');

	if (section === 'plan') {
		lines.push('## Plan');
		lines.push(compactNarrative(task.plan || '', maxChars) || '_(no plan)_');
		return lines.join('\n');
	}

	if (section === 'walkthrough') {
		lines.push('## Walkthrough');
		lines.push(compactNarrative(task.walkthrough || '', maxChars) || '_(no walkthrough)_');
		return lines.join('\n');
	}

	lines.push('## MCP Context');
	lines.push('```json');
	lines.push(
		truncateDeterministic(
			JSON.stringify(isRecord(context) ? context : {}, null, 2),
			maxChars
		)
	);
	lines.push('```');
	return lines.join('\n');
}

export function renderTaskLifecycle(task: TaskResponse): string {
	const context = isRecord(task.mcpContext) ? task.mcpContext : {};
	return [
		`# Lifecycle · ${task.title}`,
		'',
		`- Task ID: \`${task.id}\``,
		`- Status: ${task.status}`,
		`- Priority: ${task.priority}`,
		`- Last tool: ${String(context.last_tool || context.tool || 'n/a')}`,
		`- Last operation: ${String(context.last_operation_id || 'n/a')}`,
		`- Chat ID: ${String(context.chat_id || context.last_chat_id || 'n/a')}`,
		`- Session ID: ${String(context.session_id || context.last_session_id || 'n/a')}`,
		`- Last seen: ${String(context.last_seen_at || task.updatedAt || 'n/a')}`
	].join('\n');
}

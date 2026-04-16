import { z } from 'zod';
import { compactNarrative } from './compact-context.js';
import { stripPrivate, stripPrivateDeep, truncateDeterministic } from './utils.js';
import type { TaskResponse } from '../tools/task-common.js';

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
	sections.push('');

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
		sections.push(`- Session ID: ${String(context.session_id || context.last_chat_id || 'n/a')}`);
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
		`- Session ID: ${String(context.session_id || context.last_chat_id || 'n/a')}`,
		`- Last seen: ${String(context.last_seen_at || task.updatedAt || 'n/a')}`
	].join('\n');
}

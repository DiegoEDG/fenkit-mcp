import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { requireProject } from '../config.js';
import { getApiClient, formatApiError } from '../api.js';
import { PlanSchema, WalkthroughSchema } from '../schemas.js';
import { buildExecutionMetadata } from '../utils.js';
import { resolveTaskByIdentifier } from './task-common.js';

function renderPlanMarkdown(plan: z.infer<typeof PlanSchema>): string {
	const lines: string[] = [];
	lines.push('## Summary');
	lines.push(plan.summary);
	lines.push('');

	lines.push('## Steps');
	for (const step of plan.steps) {
		lines.push(`- ${step}`);
	}
	lines.push('');

	lines.push('## Files Affected');
	for (const file of plan.files_affected) {
		lines.push(`- \`${file}\``);
	}
	lines.push('');

	if (plan.risks?.length) {
		lines.push('## Risks');
		for (const risk of plan.risks) {
			lines.push(`- ${risk}`);
		}
		lines.push('');
	}

	if (plan.assumptions?.length) {
		lines.push('## Assumptions');
		for (const assumption of plan.assumptions) {
			lines.push(`- ${assumption}`);
		}
		lines.push('');
	}

	if (plan.open_questions?.length) {
		lines.push('## Open Questions');
		for (const question of plan.open_questions) {
			lines.push(`- ${question}`);
		}
		lines.push('');
	}

	if (plan.estimated_complexity) {
		lines.push('## Estimated Complexity');
		lines.push(plan.estimated_complexity);
		lines.push('');
	}

	if (plan.notes) {
		lines.push('## Notes');
		lines.push(plan.notes);
		lines.push('');
	}

	return lines.join('\n').trim();
}

function renderWalkthroughMarkdown(walkthrough: z.infer<typeof WalkthroughSchema>): string {
	const lines: string[] = [];
	lines.push('## Summary');
	lines.push(walkthrough.summary);
	lines.push('');

	lines.push('## Changes');
	for (const item of walkthrough.changes) {
		lines.push(`- ${item}`);
	}
	lines.push('');

	lines.push('## Files Modified');
	for (const file of walkthrough.files_modified) {
		lines.push(`- \`${file}\``);
	}
	lines.push('');

	if (walkthrough.decisions?.length) {
		lines.push('## Decisions');
		for (const decision of walkthrough.decisions) {
			lines.push(`- ${decision}`);
		}
		lines.push('');
	}

	if (walkthrough.testing?.length) {
		lines.push('## Testing');
		for (const test of walkthrough.testing) {
			lines.push(`- ${test}`);
		}
		lines.push('');
	}

	if (walkthrough.known_issues?.length) {
		lines.push('## Known Issues');
		for (const issue of walkthrough.known_issues) {
			lines.push(`- ${issue}`);
		}
		lines.push('');
	}

	if (walkthrough.next_steps?.length) {
		lines.push('## Next Steps');
		for (const next of walkthrough.next_steps) {
			lines.push(`- ${next}`);
		}
		lines.push('');
	}

	if (walkthrough.notes) {
		lines.push('## Notes');
		lines.push(walkthrough.notes);
		lines.push('');
	}

	return lines.join('\n').trim();
}

/**
 * Phase 2 + 3: Task write tools
 * PRD Sections 6.4, 8.2 (auto-inject execution_metadata on writes)
 */
export function registerTaskWriteTools(server: McpServer): void {
	// update_task_plan — PATCH with structured plan
	server.tool(
		'update_task_plan',
		'Submit or update an implementation plan for a task. The plan must follow the structured schema with summary, steps, files_affected, etc. Use this after retrieving compact context and analyzing the requirements. Stores full markdown plan plus structured schema in metadata.',
		{
			taskId: z.string().describe('Task ID (full UUID or truncated prefix)'),
			plan: PlanSchema,
			model: z.string().describe('Model used for this plan (e.g. "claude-sonnet-4-20250514")'),
			agent: z.string().describe('Agent/client name (e.g. "cursor", "claude-desktop")')
		},
		async ({ taskId, plan, model, agent }) => {
			try {
				// Validate plan schema
				const parsed = PlanSchema.parse(plan);
				const planContent = renderPlanMarkdown(parsed);

				const config = requireProject();
				const projectId = config.currentProjectId;
				if (!projectId) throw new Error('NO_ACTIVE_PROJECT: No project selected.');
				const api = getApiClient();
				const currentTask = await resolveTaskByIdentifier(api, projectId, taskId);

				const existingMetadata = (currentTask.implementationMetadata as Record<string, unknown>) || {};
				const existingMcp = (existingMetadata.mcp as Record<string, unknown>) || {};
				const history = (existingMetadata.history as unknown[]) || [];

				// Build execution metadata (Phase 3: auto-inject)
				const execution = buildExecutionMetadata(planContent, {
					model,
					agent,
					lastRetrievedAt: existingMetadata.lastRetrievedAt as string | undefined
				});

				const updatedMetadata = {
					...existingMetadata,
					mcp: {
						...existingMcp,
						planSchema: parsed
					},
					lastExecution: execution,
					history: [...history, { ...execution, action: 'update_plan' }]
				};

				await api.patch(`/projects/${projectId}/tasks/${currentTask.id}`, {
					plan: planContent,
					implementationMetadata: updatedMetadata
				});

				return {
					content: [
						{
							type: 'text' as const,
							text: `✔ Plan updated for task \`${currentTask.id.substring(0, 5)}\`.\n\n**Steps**: ${parsed.steps.length}\n**Files affected**: ${parsed.files_affected.length}\n**Complexity**: ${parsed.estimated_complexity || 'not specified'}`
						}
					]
				};
			} catch (error) {
				if (error instanceof z.ZodError) {
					const issues = error.issues.map((i) => `- ${i.path.join('.')}: ${i.message}`).join('\n');
					return {
						content: [{ type: 'text' as const, text: `INVALID_INPUT: Plan validation failed:\n${issues}` }],
						isError: true
					};
				}
				const err = formatApiError(error);
				return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
			}
		}
	);

	// update_task_walkthrough — PATCH with structured walkthrough
	server.tool(
		'update_task_walkthrough',
		'Submit or update an implementation walkthrough for a task. The walkthrough must follow the structured schema with summary, changes, files_modified, decisions, testing, etc. Stores full markdown walkthrough plus structured schema in metadata.',
		{
			taskId: z.string().describe('Task ID (full UUID or truncated prefix)'),
			walkthrough: WalkthroughSchema,
			model: z.string().describe('Model used for this walkthrough'),
			agent: z.string().describe('Agent/client name')
		},
		async ({ taskId, walkthrough, model, agent }) => {
			try {
				const parsed = WalkthroughSchema.parse(walkthrough);
				const walkthroughContent = renderWalkthroughMarkdown(parsed);

				const config = requireProject();
				const projectId = config.currentProjectId;
				if (!projectId) throw new Error('NO_ACTIVE_PROJECT: No project selected.');
				const api = getApiClient();
				const currentTask = await resolveTaskByIdentifier(api, projectId, taskId);

				const existingMetadata = (currentTask.implementationMetadata as Record<string, unknown>) || {};
				const existingMcp = (existingMetadata.mcp as Record<string, unknown>) || {};
				const history = (existingMetadata.history as unknown[]) || [];

				const execution = buildExecutionMetadata(walkthroughContent, {
					model,
					agent,
					lastRetrievedAt: existingMetadata.lastRetrievedAt as string | undefined
				});

				const updatedMetadata = {
					...existingMetadata,
					mcp: {
						...existingMcp,
						walkthroughSchema: parsed
					},
					lastExecution: execution,
					history: [...history, { ...execution, action: 'update_walkthrough' }]
				};

				await api.patch(`/projects/${projectId}/tasks/${currentTask.id}`, {
					walkthrough: walkthroughContent,
					implementationMetadata: updatedMetadata
				});

				return {
					content: [
						{
							type: 'text' as const,
							text: `✔ Walkthrough updated for task \`${currentTask.id.substring(0, 5)}\`.\n\n**Changes**: ${parsed.changes.length}\n**Files modified**: ${parsed.files_modified.length}`
						}
					]
				};
			} catch (error) {
				if (error instanceof z.ZodError) {
					const issues = error.issues.map((i) => `- ${i.path.join('.')}: ${i.message}`).join('\n');
					return {
						content: [{ type: 'text' as const, text: `INVALID_INPUT: Walkthrough validation failed:\n${issues}` }],
						isError: true
					};
				}
				const err = formatApiError(error);
				return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
			}
		}
	);

	// update_task_metadata — PATCH for status/priority changes
	server.tool(
		'update_task_metadata',
		'Update task status, priority, or other metadata fields. Use this for lifecycle transitions (e.g. moving a task from "todo" to "in_progress" or marking it "done").',
		{
			taskId: z.string().describe('Task ID (full UUID or truncated prefix)'),
			status: z.string().optional().describe('New status: todo, in_progress, done, backlog, frozen'),
			priority: z.string().optional().describe('New priority: low, medium, high, urgent'),
			model: z.string().describe('Model used (for execution metadata tracking)'),
			agent: z.string().describe('Agent/client name')
		},
			async ({ taskId, status, priority, model, agent }) => {
				try {
					const config = requireProject();
					const projectId = config.currentProjectId;
					if (!projectId) throw new Error('NO_ACTIVE_PROJECT: No project selected.');
					const api = getApiClient();
					const currentTask = await resolveTaskByIdentifier(api, projectId, taskId);

				const updatePayload: Record<string, unknown> = {};
				if (status) updatePayload.status = status;
				if (priority) updatePayload.priority = priority;

				if (Object.keys(updatePayload).length === 0) {
					return {
						content: [{ type: 'text' as const, text: 'INVALID_INPUT: Must provide at least one of: status, priority' }],
						isError: true
					};
				}

				// Fetch current metadata for history tracking
				const existingMetadata = (currentTask.implementationMetadata as Record<string, unknown>) || {};
				const history = (existingMetadata.history as unknown[]) || [];

				const execution = buildExecutionMetadata(JSON.stringify(updatePayload), {
					model,
					agent,
					lastRetrievedAt: existingMetadata.lastRetrievedAt as string | undefined
				});

				const changesSnapshot = { ...updatePayload };
				updatePayload.implementationMetadata = {
					...existingMetadata,
					lastExecution: execution,
					history: [...history, { ...execution, action: 'update_metadata', changes: changesSnapshot }]
				};

					await api.patch(`/projects/${projectId}/tasks/${currentTask.id}`, updatePayload);

				const changes = [];
				if (status) changes.push(`Status → ${status}`);
				if (priority) changes.push(`Priority → ${priority}`);

				return {
					content: [
						{
							type: 'text' as const,
							text: `✔ Task \`${currentTask.id.substring(0, 5)}\` updated: ${changes.join(', ')}`
						}
					]
				};
			} catch (error) {
				const err = formatApiError(error);
				return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
			}
		}
	);
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { requireProject } from '../config.js';
import { getApiClient } from '../api.js';
import { resolveTaskByIdentifier } from '../tools/task-common.js';
import { clampMaxChars } from '../compact-context.js';
import { renderCompactContext, renderTaskSection, SectionSchema } from '../task-context-render.js';

export function registerLifecyclePrompts(server: McpServer): void {
	server.registerPrompt(
		'task-plan',
		{
			title: 'Task Plan Prompt',
			description: 'Reusable compact-first planning prompt for a Fenkit task.',
			argsSchema: {
				taskId: z.string().trim().min(4).max(64),
				maxChars: z.number().int().min(500).max(12000).optional()
			}
		},
		async ({ taskId, maxChars }) => {
			const config = requireProject();
			const api = getApiClient();
			const task = await resolveTaskByIdentifier(api, config.currentProjectId!, taskId);
			const compact = renderCompactContext(task, clampMaxChars(maxChars));
			return {
				messages: [
					{
						role: 'user',
						content: {
							type: 'text',
							text: `Create a structured implementation plan for this task using compact context first.\n\n${compact}`
						}
					}
				]
			};
		}
	);

	server.registerPrompt(
		'task-execute-checklist',
		{
			title: 'Task Execute Checklist',
			description: 'Execution checklist prompt aligned with Fenkit lifecycle.',
			argsSchema: {
				taskId: z.string().trim().min(4).max(64)
			}
		},
		async ({ taskId }) => {
			return {
				messages: [
					{
						role: 'user',
						content: {
							type: 'text',
							text: [
								`Execute task ${taskId} using this checklist:`,
								'- Load compact context first.',
								'- Expand only required sections.',
								'- Persist plan before execution updates.',
								'- Move status to in_progress when coding starts.',
								'- Persist walkthrough when done (status to in_review).'
							].join('\n')
						}
					}
				]
			};
		}
	);

	server.registerPrompt(
		'task-walkthrough',
		{
			title: 'Task Walkthrough Prompt',
			description: 'Reusable prompt for generating post-execution walkthroughs.',
			argsSchema: {
				taskId: z.string().trim().min(4).max(64),
				maxChars: z.number().int().min(500).max(12000).optional()
			}
		},
		async ({ taskId, maxChars }) => {
			const config = requireProject();
			const api = getApiClient();
			const task = await resolveTaskByIdentifier(api, config.currentProjectId!, taskId);
			const compact = renderCompactContext(task, clampMaxChars(maxChars));
			return {
				messages: [
					{
						role: 'user',
						content: {
							type: 'text',
							text: `Prepare a structured implementation walkthrough for this task.\n\n${compact}`
						}
					}
				]
			};
		}
	);

	server.registerPrompt(
		'task-rework',
		{
			title: 'Task Rework Prompt',
			description: 'Prompt for rework flows using compact context + latest walkthrough.',
			argsSchema: {
				taskId: z.string().trim().min(4).max(64),
				maxChars: z.number().int().min(500).max(12000).optional()
			}
		},
		async ({ taskId, maxChars }) => {
			const config = requireProject();
			const api = getApiClient();
			const task = await resolveTaskByIdentifier(api, config.currentProjectId!, taskId);
			const section = renderTaskSection(task, SectionSchema.enum.walkthrough, clampMaxChars(maxChars));
			const compact = renderCompactContext(task, clampMaxChars(maxChars));
			return {
				messages: [
					{
						role: 'user',
						content: {
							type: 'text',
							text: `Use this compact context and latest walkthrough to plan the rework.\n\n${compact}\n\n${section}`
						}
					}
				]
			};
		}
	);
}

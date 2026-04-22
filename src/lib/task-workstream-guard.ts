/**
 * Workstream Guard - Mutation Validation for Scoped Execution
 *
 * This module provides pre-action validators that ensure mutations
 * only affect tasks within the active workstream boundary.
 */

import type { TaskResponse } from '@tools/task-common.js';

/**
 * Workstream execution context - must be provided by the calling agent/orchestrator
 */
export interface WorkstreamExecutionContext {
	workstreamId: string;
	rootTaskId: string;
	allowedTaskIds: string[];
	executionStatuses: string[];
}

/**
 * Result of workstream validation
 */
export interface WorkstreamValidationResult {
	isValid: boolean;
	message: string;
	suggestedAction?: 'switch_workstream' | 'confirm' | 'proceed';
}

/**
 * Validate that a task mutation is within the workstream scope
 *
 * @param targetTaskId - Task ID being mutated
 * @param context - Active workstream execution context
 * @returns Validation result
 */
export function validateWorkstreamMutation(
	targetTaskId: string,
	context: WorkstreamExecutionContext,
): WorkstreamValidationResult {
	// Check if task is in allowlist
	const isInAllowlist = context.allowedTaskIds.includes(targetTaskId);

	if (!isInAllowlist) {
		return {
			isValid: false,
			message: `Task "${targetTaskId}" is outside the active workstream boundary (workstream_id: ${context.workstreamId}). ` +
				`Only tasks in the allowlist [${context.allowedTaskIds.slice(0, 3).join(', ')}${context.allowedTaskIds.length > 3 ? '...' : ''}] ` +
				`can be mutated.`,
			suggestedAction: 'switch_workstream',
		};
	}

	return {
		isValid: true,
		message: `Task "${targetTaskId}" is within workstream scope (workstream_id: ${context.workstreamId})`,
		suggestedAction: 'proceed',
	};
}

/**
 * Validate a batch of task mutations
 *
 * @param targetTaskIds - Task IDs being mutated
 * @param context - Active workstream execution context
 * @returns Validation result with details
 */
export function validateWorkstreamMutationBatch(
	targetTaskIds: string[],
	context: WorkstreamExecutionContext,
): WorkstreamValidationResult & { validCount: number; invalidTaskIds: string[] } {
	const invalidTaskIds: string[] = [];

	for (const taskId of targetTaskIds) {
		if (!context.allowedTaskIds.includes(taskId)) {
			invalidTaskIds.push(taskId);
		}
	}

	if (invalidTaskIds.length > 0) {
		return {
			isValid: false,
			message: `${invalidTaskIds.length} task(s) are outside the active workstream boundary: ` +
				`${invalidTaskIds.join(', ')}`,
			suggestedAction: 'switch_workstream',
			validCount: targetTaskIds.length - invalidTaskIds.length,
			invalidTaskIds,
		};
	}

	return {
		isValid: true,
		message: `All ${targetTaskIds.length} task(s) are within workstream scope`,
		suggestedAction: 'proceed',
		validCount: targetTaskIds.length,
		invalidTaskIds: [],
	};
}

/**
 * Check if workstream context is properly initialized
 *
 * @param context - Workstream execution context to validate
 * @returns True if context is valid
 */
export function isWorkstreamContextValid(
	context: WorkstreamExecutionContext | null | undefined,
): boolean {
	if (!context) {
		return false;
	}

	return !!(
		context.workstreamId &&
		context.rootTaskId &&
		context.allowedTaskIds &&
		context.allowedTaskIds.length > 0
	);
}

/**
 * Create workstream context from task response
 *
 * Extracts workstream information from a task to establish execution context.
 * Falls back to single-task workstream if no workstream_id exists.
 *
 * @param task - Task response with workstream fields
 * @param executionStatuses - Statuses to include in closure
 * @returns Workstream execution context
 */
export function createWorkstreamContextFromTask(
	task: Pick<TaskResponse, 'id' | 'workstreamId' | 'rootTaskId' | 'workstreamTag'>,
	executionStatuses: string[] = ['todo', 'in_progress', 'in_review'],
): WorkstreamExecutionContext {
	const workstreamId = task.workstreamId ?? task.id;
	const rootTaskId = task.rootTaskId ?? task.id;

	return {
		workstreamId,
		rootTaskId,
		// Note: allowedTaskIds must be resolved via service call
		// This creates a minimal context that should be expanded
		allowedTaskIds: [task.id],
		executionStatuses,
	};
}

/**
 * Standard blocked action response message
 *
 * Returns a standardized message for blocked mutations.
 */
export function getBlockedActionMessage(
	targetTaskId: string,
	workstreamId: string,
): string {
	return `Task "${targetTaskId}" is outside the active workstream boundary (workstream_id: ${workstreamId}). ` +
		`Confirm to switch workstreams or continue with current workstream.`;
}

/**
 * Minimal Prompt Contract for workstream-scoped execution
 *
 * This can be included in executor prompts to enforce workstream boundaries.
 */
export const WORKSTREAM_PROMPT_CONTRACT = `You are executing within ONE workstream.

Workstream Context:
- workstream_id: <WORKSTREAM_ID>
- root_task_id: <ROOT_TASK_ID>
- allowed_task_ids: [<ID1>, <ID2>, ...]

Hard Rules:
1) Only read/update tasks in allowed_task_ids.
2) If requested task is outside allowlist, STOP and ask to switch workstream.
3) Process only dependency-ready tasks inside allowlist.
4) Do not use global active tasks for selection.
5) Completion = all allowlisted tasks satisfy done policy.`;
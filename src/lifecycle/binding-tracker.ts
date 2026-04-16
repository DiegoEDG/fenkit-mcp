/**
 * Binding Tracker — In-memory state for MCP-bound tasks
 * 
 * When a task is fetched via MCP read tools (get_task_context_compact,
 * resolve_session_task, etc.), it becomes "bound" and is tracked here.
 * 
 * This tracker is the LOCAL source of truth for whether a task is under
 * lifecycle enforcement and what step of the lifecycle it's at.
 * 
 * The tracker is a singleton per MCP process, persisted in memory only.
 * For multi-instance deployments, the backend also tracks bindings via
 * task_sessions table (see mcp-tasks-sessions.service.ts).
 */

import type { BoundTask, LifecycleState } from './lifecycle-config.js';
import { LifecycleStep } from './lifecycle-config.js';
import { createLogger } from '@lib/logger.js';

const logger = createLogger('binding-tracker');

/**
 * Singleton class that tracks all MCP-bound tasks in the current process.
 * 
 * Usage:
 * ```typescript
 * import { bindingTracker } from './lifecycle/binding-tracker.js';
 * 
 * // When a task is fetched via MCP read tool
 * bindingTracker.bind(task);
 * 
 * // Check if task is bound
 * if (bindingTracker.isBound(taskId)) { ... }
 * 
 * // Get current lifecycle state
 * const state = bindingTracker.getState(taskId);
 * 
 * // Mark a step as completed
 * bindingTracker.markPlanWritten(taskId);
 * ```
 */
export class BindingTracker {
	/**
	 * Map of taskId -> BoundTask
	 * Key is the full UUID of the task.
	 */
	private boundTasks = new Map<string, BoundTask>();

	/**
	 * Current active task being worked on.
	 * This is the task that lifecycle enforcement applies to.
	 */
	private currentTaskId: string | null = null;

	/**
	 * Bind a task to the current MCP session.
	 * Call this when a task is fetched via any MCP read tool.
	 * 
	 * @param task - The task response from the API
	 * @param projectId - The project ID
	 * @param chatId - The chat/session ID (from headers or explicit)
	 */
	bind(task: {
		id: string;
		projectId: string;
		status: string;
		plan?: string | null;
		walkthrough?: string | null;
	}, projectId: string, chatId: string): void {
		const now = new Date();

		// Determine lifecycle state from existing task data
		const lifecycle: LifecycleState = {
			boundAt: now,
			planWrittenAt: task.plan && task.plan.trim().length > 0 ? now : null,
			inProgressAt: task.status === 'in_progress' ? now : null,
			walkthroughWrittenAt: task.walkthrough && task.walkthrough.trim().length > 0 ? now : null,
			inReviewAt: task.status === 'in_review' ? now : null,
		};

		const boundTask: BoundTask = {
			taskId: task.id,
			projectId,
			chatId,
			initialStatus: task.status,
			lifecycle,
		};

		this.boundTasks.set(task.id, boundTask);
		this.currentTaskId = task.id;

		logger.debug(`Task bound: ${task.id} (status: ${task.status})`);
	}

	/**
	 * Check if a task is currently bound.
	 */
	isBound(taskId: string): boolean {
		return this.boundTasks.has(taskId);
	}

	/**
	 * Get the current active task ID.
	 */
	getCurrentTaskId(): string | null {
		return this.currentTaskId;
	}

	/**
	 * Set the current active task (when user selects a different bound task).
	 */
	setCurrentTask(taskId: string): void {
		if (!this.boundTasks.has(taskId)) {
			logger.warn(`Cannot set current task to unbound: ${taskId}`);
			return;
		}
		this.currentTaskId = taskId;
	}

	/**
	 * Get the bound task data.
	 */
	getBoundTask(taskId: string): BoundTask | undefined {
		return this.boundTasks.get(taskId);
	}

	/**
	 * Get the lifecycle state for a bound task.
	 */
	getState(taskId: string): LifecycleState | null {
		const bound = this.boundTasks.get(taskId);
		return bound ? bound.lifecycle : null;
	}

	/**
	 * Get the current lifecycle step for a bound task.
	 * Returns the current step based on what's been completed.
	 */
	getCurrentStep(taskId: string): LifecycleStep | null {
		const state = this.getState(taskId);
		if (!state) return null;

		if (state.inReviewAt) return LifecycleStep.IN_REVIEW;
		if (state.walkthroughWrittenAt) return LifecycleStep.WALKTHROUGH;
		if (state.inProgressAt) return LifecycleStep.IN_PROGRESS;
		if (state.planWrittenAt) return LifecycleStep.PLAN;
		return LifecycleStep.BOUND;
	}

	/**
	 * Get the next required step for a bound task.
	 * Returns what needs to be done to complete the lifecycle.
	 */
	getNextRequiredStep(taskId: string): LifecycleStep | null {
		const state = this.getState(taskId);
		if (!state) return null;

		// Already complete?
		if (state.inReviewAt) return null;

		// Missing plan?
		if (!state.planWrittenAt) return LifecycleStep.PLAN;

		// Has plan but not in_progress?
		if (!state.inProgressAt) return LifecycleStep.IN_PROGRESS;

		// Has plan, in_progress, but no walkthrough?
		if (!state.walkthroughWrittenAt) return LifecycleStep.WALKTHROUGH;

		// Has walkthrough but not in_review?
		if (!state.inReviewAt) return LifecycleStep.IN_REVIEW;

		return null;
	}

	/**
	 * Check if a specific step has been completed.
	 */
	hasCompletedStep(taskId: string, step: LifecycleStep): boolean {
		const state = this.getState(taskId);
		if (!state) return false;

		switch (step) {
			case LifecycleStep.BOUND:
				return state.boundAt !== null;
			case LifecycleStep.PLAN:
				return state.planWrittenAt !== null;
			case LifecycleStep.IN_PROGRESS:
				return state.inProgressAt !== null;
			case LifecycleStep.WALKTHROUGH:
				return state.walkthroughWrittenAt !== null;
			case LifecycleStep.IN_REVIEW:
				return state.inReviewAt !== null;
			default:
				return false;
		}
	}

	/**
	 * Mark plan as written.
	 */
	markPlanWritten(taskId: string): void {
		const bound = this.boundTasks.get(taskId);
		if (!bound) {
			logger.warn(`Cannot mark plan written for unbound task: ${taskId}`);
			return;
		}
		bound.lifecycle.planWrittenAt = new Date();
		logger.debug(`Plan written for: ${taskId}`);
	}

	/**
	 * Mark status as in_progress.
	 */
	markInProgress(taskId: string): void {
		const bound = this.boundTasks.get(taskId);
		if (!bound) {
			logger.warn(`Cannot mark in_progress for unbound task: ${taskId}`);
			return;
		}
		bound.lifecycle.inProgressAt = new Date();
		logger.debug(`Status set to in_progress for: ${taskId}`);
	}

	/**
	 * Mark walkthrough as written.
	 */
	markWalkthroughWritten(taskId: string): void {
		const bound = this.boundTasks.get(taskId);
		if (!bound) {
			logger.warn(`Cannot mark walkthrough written for unbound task: ${taskId}`);
			return;
		}
		bound.lifecycle.walkthroughWrittenAt = new Date();
		logger.debug(`Walkthrough written for: ${taskId}`);
	}

	/**
	 * Mark status as in_review.
	 */
	markInReview(taskId: string): void {
		const bound = this.boundTasks.get(taskId);
		if (!bound) {
			logger.warn(`Cannot mark in_review for unbound task: ${taskId}`);
			return;
		}
		bound.lifecycle.inReviewAt = new Date();
		logger.debug(`Status set to in_review for: ${taskId}`);
	}

	/**
	 * Unbind a task (when user switches to a different task or ends session).
	 */
	unbind(taskId: string): void {
		this.boundTasks.delete(taskId);
		if (this.currentTaskId === taskId) {
			this.currentTaskId = null;
		}
		logger.debug(`Task unbound: ${taskId}`);
	}

	/**
	 * Unbind all tasks (on session end or reset).
	 */
	unbindAll(): void {
		this.boundTasks.clear();
		this.currentTaskId = null;
		logger.debug('All tasks unbound');
	}

	/**
	 * Get all bound tasks (for debugging).
	 */
	getAllBoundTasks(): BoundTask[] {
		return Array.from(this.boundTasks.values());
	}

	/**
	 * Get count of bound tasks (for monitoring).
	 */
	getBoundTaskCount(): number {
		return this.boundTasks.size;
	}
}

/**
 * Singleton instance of BindingTracker.
 * Import this in any file that needs to track or query binding state.
 */
export const bindingTracker = new BindingTracker();

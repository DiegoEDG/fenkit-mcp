/**
 * Lifecycle Module — Binding-aware Lifecycle Enforcement
 * 
 * This module provides binding tracking and lifecycle enforcement for
 * tasks that are fetched via MCP read tools.
 * 
 * Usage:
 * ```typescript
 * import { bindingTracker, lifecycleGate } from './lifecycle/index.js';
 * 
 * // When a task is fetched via MCP read tool
 * bindingTracker.bind(task, projectId, chatId);
 * 
 * // Before allowing LLM to continue
 * const result = await lifecycleGate.enforceBeforeContinue();
 * 
 * // After update_task_plan is called
 * lifecycleGate.markPlanWritten(taskId);
 * ```
 */

// Config & types
export {
	LifecycleMode,
	LifecycleStep,
	LifecycleState,
	BoundTask,
	AutoRepairResult,
	LifecycleViolation,
	LIFECYCLE_MODE,
	isEnforcementActive,
	isStrictMode,
	isWarnMode,
} from './lifecycle-config.js';

// Binding tracker
export { BindingTracker, bindingTracker } from './binding-tracker.js';

// Lifecycle gate
export { LifecycleGate, lifecycleGate } from './lifecycle-gate.js';

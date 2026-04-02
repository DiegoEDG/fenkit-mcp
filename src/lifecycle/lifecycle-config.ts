/**
 * Lifecycle Enforcement Configuration
 * 
 * Controls how strictly the MCP enforces write tool usage for bound tasks.
 * When a task is fetched via MCP read tools, it becomes "bound" and
 * lifecycle enforcement activates.
 */

// ─── Lifecycle Modes ──────────────────────────────────────────────────────────

export enum LifecycleMode {
	/**
	 * No enforcement — lifecycle tools are optional.
	 * Good for gradual rollout or testing.
	 */
	OFF = 'off',

	/**
	 * Violations are logged but not blocked.
	 * Good for observing behavior before enabling strict mode.
	 */
	WARN = 'warn',

	/**
	 * Violations block the operation and return an error.
	 * The MCP client should auto-repair before retrying.
	 */
	STRICT = 'strict',
}

// ─── Lifecycle Steps ──────────────────────────────────────────────────────────

/**
 * The ordered steps in the task lifecycle.
 * Each bound task must pass through these steps.
 */
export enum LifecycleStep {
	/** Step 0: Task was fetched via MCP read tool - binding created */
	BOUND = 'bound',

	/** Step 1: Plan must be written before starting work */
	PLAN = 'plan',

	/** Step 2: Status must be in_progress during implementation */
	IN_PROGRESS = 'in_progress',

	/** Step 3: Walkthrough must be written when work is done */
	WALKTHROUGH = 'walkthrough',

	/** Step 4: Status must be in_review for review */
	IN_REVIEW = 'in_review',
}

// ─── Lifecycle State ──────────────────────────────────────────────────────────

/**
 * Tracks the lifecycle state for a bound task.
 * This is stored in-memory in the BindingTracker.
 */
export interface LifecycleState {
	/** When the task was bound (fetched via MCP read tool) */
	boundAt: Date | null;

	/** When update_task_plan was called */
	planWrittenAt: Date | null;

	/** When set_task_status(in_progress) was called */
	inProgressAt: Date | null;

	/** When update_task_walkthrough was called */
	walkthroughWrittenAt: Date | null;

	/** When set_task_status(in_review) was called */
	inReviewAt: Date | null;
}

// ─── Bound Task ───────────────────────────────────────────────────────────────

/**
 * Represents a task that was fetched via MCP and is now under
 * lifecycle enforcement.
 */
export interface BoundTask {
	taskId: string;
	projectId: string;
	chatId: string;
	/** Status at the moment of binding (before any lifecycle writes) */
	initialStatus: string;
	lifecycle: LifecycleState;
}

// ─── Auto-Repair Result ──────────────────────────────────────────────────────

/**
 * Result of an auto-repair operation in LifecycleGate.
 */
export interface AutoRepairResult {
	/** Whether auto-repair was executed */
	enforced: boolean;

	/** The step that was auto-repaired, if any */
	step?: LifecycleStep;

	/** Human-readable reason */
	reason: 'not_bound' | 'lifecycle_complete' | 'auto_repaired';

	/** The auto-repaired step that was executed */
	action?: 'plan_written' | 'walkthrough_written' | 'status_updated';
}

// ─── Lifecycle Violation ──────────────────────────────────────────────────────

/**
 * Represents a lifecycle violation — a tool was called out of order
 * or required steps were skipped.
 */
export interface LifecycleViolation {
	code: 'LIFECYCLE_VIOLATION';
	reason: 'plan_missing' | 'walkthrough_missing' | 'status_mismatch' | 'out_of_order';
	message: string;
	required_tool?: string;
	current_step?: LifecycleStep;
}

// ─── Config Access ────────────────────────────────────────────────────────────

const envMode = process.env['FENKIT_LIFECYCLE_MODE'];
const resolvedMode = envMode as LifecycleMode | undefined;

/**
 * Current lifecycle enforcement mode.
 * Defaults to STRICT — bound tasks MUST follow the lifecycle.
 * Set FENKIT_LIFECYCLE_MODE=warn for observation before enforcing.
 */
export const LIFECYCLE_MODE: LifecycleMode =
	resolvedMode && Object.values(LifecycleMode).includes(resolvedMode)
		? resolvedMode
		: LifecycleMode.STRICT;

/**
 * Whether lifecycle enforcement is active (not OFF).
 */
export const isEnforcementActive = (): boolean => LIFECYCLE_MODE !== LifecycleMode.OFF;

/**
 * Whether violations should be blocked (STRICT mode).
 */
export const isStrictMode = (): boolean => LIFECYCLE_MODE === LifecycleMode.STRICT;

/**
 * Whether violations should be logged but not blocked (WARN mode).
 */
export const isWarnMode = (): boolean => LIFECYCLE_MODE === LifecycleMode.WARN;

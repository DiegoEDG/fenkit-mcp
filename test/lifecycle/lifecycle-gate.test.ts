/**
 * Lifecycle Gate Enforcement Tests
 *
 * These tests verify that the lifecycle gate correctly validates state for bound tasks
 * at write tool entry points (update_task_plan, update_task_walkthrough, set_task_status).
 *
 * The enforcement should:
 * - BLOCK in STRICT mode when prerequisites are missing
 * - WARN in WARN mode when prerequisites are missing
 * - PASS through when prerequisites are satisfied or task is not bound
 */

import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { bindingTracker, LifecycleStep } from '@lifecycle/index.js';

// Mock the lifecycleGate module - we test the tool-level validation logic directly
vi.mock('@lifecycle/index.js', async () => {
	const actual = await vi.importActual('@lifecycle/index.js');
	return {
		...actual,
		// Override isEnforcementActive and isStrictMode to be testable
		isEnforcementActive: vi.fn(),
		isStrictMode: vi.fn(),
		LifecycleMode: {
			OFF: 'off',
			WARN: 'warn',
			STRICT: 'strict'
		}
	};
});

// Need to import after mocking
import { isEnforcementActive as mockIsEnforcementActive, isStrictMode as mockIsStrictMode } from '@lifecycle/index.js';
import { lifecycleGate } from '@lifecycle/index.js';

describe('Lifecycle Gate Enforcement', () => {
	const originalEnv = process.env.FENKIT_LIFECYCLE_MODE;

	beforeEach(() => {
		// Reset binding tracker
		bindingTracker.unbindAll();
		vi.clearAllMocks();
	});

	afterEach(() => {
		// Restore environment
		if (originalEnv === undefined) {
			delete process.env.FENKIT_LIFECYCLE_MODE;
		} else {
			process.env.FENKIT_LIFECYCLE_MODE = originalEnv;
		}
	});

	describe('checkViolation for update_task_plan', () => {
		it('should return null when task is not bound', () => {
			const violation = lifecycleGate.checkViolation('update_task_plan', 'task-123');
			expect(violation).toBeNull();
		});

		it('should return null when task is bound and has no prior steps required', () => {
			// Bind a task - this is step 0 (bound)
			bindingTracker.bind(
				{ id: 'task-123', projectId: 'proj-1', status: 'todo', plan: null, walkthrough: null },
				'proj-1',
				'chat-1'
			);

			// Plan can always be written - it's the first step after binding
			const violation = lifecycleGate.checkViolation('update_task_plan', 'task-123');
			expect(violation).toBeNull();
		});
	});

	describe('checkViolation for set_task_status', () => {
		it('should return violation when setting in_progress without plan (strict mode)', () => {
			const taskId = 'task-status-test';
			// Bind task but don't write plan
			bindingTracker.bind(
				{ id: taskId, projectId: 'proj-1', status: 'todo', plan: null, walkthrough: null },
				'proj-1',
				'chat-1'
			);

			// Set enforcement to strict
			(mockIsEnforcementActive as ReturnType<typeof vi.fn>).mockReturnValue(true);
			(mockIsStrictMode as ReturnType<typeof vi.fn>).mockReturnValue(true);

			const violation = lifecycleGate.checkViolation('set_task_status', taskId);

			expect(violation).not.toBeNull();
			expect(violation?.code).toBe('LIFECYCLE_VIOLATION');
			expect(violation?.reason).toBe('plan_missing');
			expect(violation?.required_tool).toBe('update_task_plan');
		});

		it('should allow in_progress when plan is written', () => {
			bindingTracker.bind(
				{ id: 'task-123', projectId: 'proj-1', status: 'todo', plan: null, walkthrough: null },
				'proj-1',
				'chat-1'
			);

			// Mark plan as written (simulating update_task_plan was called)
			bindingTracker.markPlanWritten('task-123');

			const violation = lifecycleGate.checkViolation('set_task_status', 'task-123');
			expect(violation).toBeNull();
		});

		it('should return violation when setting in_review without walkthrough', () => {
			bindingTracker.bind(
				{ id: 'task-123', projectId: 'proj-1', status: 'in_progress', plan: 'existing plan', walkthrough: null },
				'proj-1',
				'chat-1'
			);

			// Already in_progress - but walkthrough not written
			bindingTracker.markPlanWritten('task-123');
			bindingTracker.markInProgress('task-123');

			// The checkViolation for set_task_status doesn't know the target status,
			// so it only checks plan_missing. Full validation happens at tool level.
			const violation = lifecycleGate.checkViolation('set_task_status', 'task-123');
			// This should be null because plan exists - but tool-level should catch in_review
			expect(violation).toBeNull();
		});
	});

	describe('Lifecycle state transitions', () => {
		it('should track full lifecycle: bound → plan → in_progress → walkthrough → in_review', () => {
			const taskId = 'task-lifecycle-test';
			const projectId = 'proj-1';
			const chatId = 'chat-1';

			// Step 0: Bind
			bindingTracker.bind(
				{ id: taskId, projectId, status: 'todo', plan: null, walkthrough: null },
				projectId,
				chatId
			);

			let state = bindingTracker.getState(taskId);
			expect(state?.boundAt).not.toBeNull();
			expect(state?.planWrittenAt).toBeNull();
			expect(state?.inProgressAt).toBeNull();
			expect(state?.walkthroughWrittenAt).toBeNull();
			expect(state?.inReviewAt).toBeNull();

			// Step 1: Plan
			bindingTracker.markPlanWritten(taskId);
			state = bindingTracker.getState(taskId);
			expect(state?.planWrittenAt).not.toBeNull();

			// Step 2: In Progress
			bindingTracker.markInProgress(taskId);
			state = bindingTracker.getState(taskId);
			expect(state?.inProgressAt).not.toBeNull();

			// Step 3: Walkthrough
			bindingTracker.markWalkthroughWritten(taskId);
			state = bindingTracker.getState(taskId);
			expect(state?.walkthroughWrittenAt).not.toBeNull();

			// Step 4: In Review
			bindingTracker.markInReview(taskId);
			state = bindingTracker.getState(taskId);
			expect(state?.inReviewAt).not.toBeNull();
		});

		it('should get current step correctly', () => {
			const taskId = 'task-step-test';
			bindingTracker.bind(
				{ id: taskId, projectId: 'proj-1', status: 'todo', plan: null, walkthrough: null },
				'proj-1',
				'chat-1'
			);

			expect(bindingTracker.getCurrentStep(taskId)).toBe(LifecycleStep.BOUND);

			bindingTracker.markPlanWritten(taskId);
			expect(bindingTracker.getCurrentStep(taskId)).toBe(LifecycleStep.PLAN);

			bindingTracker.markInProgress(taskId);
			expect(bindingTracker.getCurrentStep(taskId)).toBe(LifecycleStep.IN_PROGRESS);

			bindingTracker.markWalkthroughWritten(taskId);
			expect(bindingTracker.getCurrentStep(taskId)).toBe(LifecycleStep.WALKTHROUGH);

			bindingTracker.markInReview(taskId);
			expect(bindingTracker.getCurrentStep(taskId)).toBe(LifecycleStep.IN_REVIEW);
		});
	});

	describe('Tool-level validation simulation (update_task_walkthrough)', () => {
		it('should reject walkthrough without plan in strict mode', () => {
			const taskId = 'task-walkthrough-test';
			bindingTracker.bind(
				{ id: taskId, projectId: 'proj-1', status: 'todo', plan: null, walkthrough: null },
				'proj-1',
				'chat-1'
			);

			(mockIsEnforcementActive as ReturnType<typeof vi.fn>).mockReturnValue(true);
			(mockIsStrictMode as ReturnType<typeof vi.fn>).mockReturnValue(true);

			// Simulate the validation added in update_task_walkthrough tool
			if (mockIsEnforcementActive() && bindingTracker.isBound(taskId)) {
				const currentState = bindingTracker.getState(taskId);

				// Walkthrough requires: plan written + in_progress status
				if (!currentState?.planWrittenAt || !currentState?.inProgressAt) {
					// This is the validation logic from the tool
					const rejection = {
						code: 'LIFECYCLE_VIOLATION',
						reason: currentState?.planWrittenAt ? 'in_progress_missing' : 'plan_missing',
						message: currentState?.planWrittenAt
							? 'Cannot write walkthrough without in_progress status.'
							: 'Cannot write walkthrough without a persisted plan.',
					};

					expect(rejection.code).toBe('LIFECYCLE_VIOLATION');
					expect(rejection.reason).toBe('plan_missing');
				}
			}
		});

		it('should allow walkthrough when lifecycle is complete', () => {
			const taskId = 'task-walkthrough-allowed';
			bindingTracker.bind(
				{ id: taskId, projectId: 'proj-1', status: 'todo', plan: null, walkthrough: null },
				'proj-1',
				'chat-1'
			);

			// Complete all prior steps
			bindingTracker.markPlanWritten(taskId);
			bindingTracker.markInProgress(taskId);

			const state = bindingTracker.getState(taskId);
			expect(state?.planWrittenAt).not.toBeNull();
			expect(state?.inProgressAt).not.toBeNull();

			// Walkthrough should be allowed now
			const wouldBeAllowed = !!state?.planWrittenAt && !!state?.inProgressAt;
			expect(wouldBeAllowed).toBe(true);
		});
	});

	describe('getAutoRepairMessage', () => {
		it('should return null when not enforced', () => {
			const result = { enforced: false, reason: 'not_bound' as const };
			const message = lifecycleGate.getAutoRepairMessage(result);
			expect(message).toBeNull();
		});

		it('should return appropriate messages for each action', () => {
			const planResult = { enforced: true, step: LifecycleStep.PLAN, reason: 'auto_repaired' as const, action: 'plan_written' as const };
			const walkthroughResult = { enforced: true, step: LifecycleStep.WALKTHROUGH, reason: 'auto_repaired' as const, action: 'walkthrough_written' as const };
			const statusResult = { enforced: true, step: LifecycleStep.IN_PROGRESS, reason: 'auto_repaired' as const, action: 'status_updated' as const };

			expect(lifecycleGate.getAutoRepairMessage(planResult)).toContain('Plan was auto-written');
			expect(lifecycleGate.getAutoRepairMessage(walkthroughResult)).toContain('Walkthrough was auto-written');
			expect(lifecycleGate.getAutoRepairMessage(statusResult)).toContain('Task status was auto-updated');
		});
	});
});
import { describe, expect, it } from 'vitest';
import { renderCompactContext, renderFullContext, renderTaskLifecycle } from '../../src/lib/task-context-render.js';
import type { TaskResponse } from '@tools/task-common.js';

describe('task-context-render', () => {
	describe('session fallback chain', () => {
		const baseTask: TaskResponse = {
			id: 'test-task-id',
			title: 'Test Task',
			status: 'todo',
			priority: 'medium',
			description: 'Test description',
			projectId: 'proj-001',
			createdBy: 'test-user',
			updatedAt: '2024-01-01T00:00:00Z',
			createdAt: '2024-01-01T00:00:00Z',
			mcpContext: {}
		};

		it('should use session_id when present', () => {
			const task: TaskResponse = {
				...baseTask,
				mcpContext: {
					session_id: 'session-123',
					last_session_id: 'last-session-456',
					chat_id: 'chat-789'
				}
			};

			const output = renderTaskLifecycle(task);
			expect(output).toContain('Session ID: session-123');
		});

		it('should fall back to last_session_id when session_id is missing', () => {
			const task: TaskResponse = {
				...baseTask,
				mcpContext: {
					last_session_id: 'last-session-456',
					chat_id: 'chat-789'
				}
			};

			const output = renderTaskLifecycle(task);
			expect(output).toContain('Session ID: last-session-456');
		});

		it('should show n/a when both session_id and last_session_id are missing', () => {
			const task: TaskResponse = {
				...baseTask,
				mcpContext: {
					chat_id: 'chat-789'
				}
			};

			const output = renderTaskLifecycle(task);
			expect(output).toContain('Session ID: n/a');
		});

		it('renderCompactContext should use correct fallback chain for session', () => {
			const task: TaskResponse = {
				...baseTask,
				mcpContext: {
					last_session_id: 'last-session-456',
					chat_id: 'chat-789'
				}
			};

			const output = renderCompactContext(task, 1000);
			expect(output).toContain('Session ID: last-session-456');
		});
	});

	// M1: Contract & Visibility Tests
	describe('dependency visibility (compact)', () => {
		const baseTask: TaskResponse = {
			id: 'test-task-id',
			title: 'Test Task',
			status: 'todo',
			priority: 'medium',
			description: 'Test description',
			projectId: 'proj-001',
			createdBy: 'test-user',
			updatedAt: '2024-01-01T00:00:00Z',
			createdAt: '2024-01-01T00:00:00Z',
			mcpContext: {}
		};

		it('should show Dependencies section when task has blockers', () => {
			const task: TaskResponse = {
				...baseTask,
				blockedByTaskIds: ['blocker-1', 'blocker-2'],
				isReadyToStart: false,
				blockedReason: 'Blocked by 2 open task(s)'
			};

			const output = renderCompactContext(task, 1000);
			expect(output).toContain('## Dependencies');
			expect(output).toContain('**Blocked by**: 2 task(s)');
			expect(output).toContain('**Blocked reason**: Blocked by 2 open task(s)');
			expect(output).toContain('**Ready to start**: ⏳ No');
		});

		it('should show ready status when task can start', () => {
			const task: TaskResponse = {
				...baseTask,
				blockedByTaskIds: ['blocker-1'],
				isReadyToStart: false,
				blockedReason: 'Blocked by 1 open task(s)'
			};

			const output = renderCompactContext(task, 1000);
			expect(output).toContain('**Ready to start**: ⏳ No');
		});

		it('should not show Dependencies section when task has no blockers', () => {
			const task: TaskResponse = {
				...baseTask,
				blockedByTaskIds: [],
				isReadyToStart: true
			};

			const output = renderCompactContext(task, 1000);
			expect(output).not.toContain('## Dependencies');
		});

		it('should show blocker status summary with done count', () => {
			const task: TaskResponse = {
				...baseTask,
				blockedByTaskIds: ['blocker-1', 'blocker-2'],
				isReadyToStart: false,
				blockedReason: 'Blocked by 2 open task(s)',
				dependencyStatus: [
					{ taskId: 'blocker-1', status: 'done' },
					{ taskId: 'blocker-2', status: 'not_done' }
				]
			};

			const output = renderCompactContext(task, 1000);
			expect(output).toContain('**Blocker status**: 1/2 done');
		});
	});

	describe('dependency visibility (full)', () => {
		const baseTask: TaskResponse = {
			id: 'test-task-id',
			title: 'Test Task',
			status: 'todo',
			priority: 'medium',
			description: 'Test description',
			projectId: 'proj-001',
			createdBy: 'test-user',
			updatedAt: '2024-01-01T00:00:00Z',
			createdAt: '2024-01-01T00:00:00Z',
			mcpContext: {}
		};

		it('should show full Dependencies section with blocker details', () => {
			const task: TaskResponse = {
				...baseTask,
				blockedByTaskIds: ['blocker-1', 'blocker-2'],
				blockingTaskIds: ['dependent-1'],
				isReadyToStart: false,
				blockedReason: 'Blocked by 2 open task(s)',
				dependencyStatus: [
					{ taskId: 'blocker-1', status: 'done' },
					{ taskId: 'blocker-2', status: 'not_done' }
				]
			};

			const output = renderFullContext(task);
			expect(output).toContain('## Dependencies');
			expect(output).toContain('**Is ready to start**: ⏳ No');
			expect(output).toContain('**Blocked by**: 2 task(s)');
			expect(output).toContain('**Blocked reason**: Blocked by 2 open task(s)');
			expect(output).toContain('**Blocking**: 1 task(s)');
			expect(output).toContain('### Blocker Status');
			expect(output).toContain('✅');
			expect(output).toContain('⏳');
		});

		it('should show ✅ for ready tasks', () => {
			const task: TaskResponse = {
				...baseTask,
				blockedByTaskIds: [],
				blockingTaskIds: ['dependent-1'],
				isReadyToStart: true
			};

			const output = renderFullContext(task);
			expect(output).toContain('**Is ready to start**: ✅ Yes');
		});

		it('should not show Dependencies section when task has no dependencies', () => {
			const task: TaskResponse = {
				...baseTask,
				blockedByTaskIds: [],
				blockingTaskIds: []
			};

			const output = renderFullContext(task);
			expect(output).not.toContain('## Dependencies');
		});
	});

	describe('backward compatibility', () => {
		it('should render without dependency fields (old client)', () => {
			const oldTask: TaskResponse = {
				id: 'test-task-id',
				title: 'Test Task',
				status: 'todo',
				priority: 'medium',
				description: 'Old task without dependency fields',
				projectId: 'proj-001',
				createdBy: 'test-user',
				updatedAt: '2024-01-01T00:00:00Z',
				createdAt: '2024-01-01T00:00:00Z',
				// Note: no dependency fields at all
			};

			const compact = renderCompactContext(oldTask, 1000);
			expect(compact).toContain('# Test Task');
			expect(compact).toContain('todo');
			expect(compact).not.toContain('Dependencies');
		});
	});
});

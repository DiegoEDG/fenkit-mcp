import { describe, expect, it } from 'vitest';
import { renderCompactContext, renderTaskLifecycle } from '../../src/lib/task-context-render.js';
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
});

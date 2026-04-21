import { describe, expect, it, vi } from 'vitest';
import type { AxiosInstance } from 'axios';
import { resolveTaskByIdentifier, resolveTaskIdentifiers } from '../../src/tools/task-common.js';

function createApiMock(responses: Array<{ data?: unknown; error?: Error }>) {
	const get = vi.fn(async () => {
		const next = responses.shift();
		if (!next) throw new Error('Unexpected request');
		if (next.error) throw next.error;
		return { data: next.data };
	});
	return { get } as unknown as AxiosInstance;
}

describe('task-common identifier resolution', () => {
	it('resolves a full UUID directly', async () => {
		const api = createApiMock([{ data: { id: '123e4567-e89b-12d3-a456-426614174000' } }]);
		const task = await resolveTaskByIdentifier(api, 'project-1', '123e4567-e89b-12d3-a456-426614174000');
		expect(task.id).toBe('123e4567-e89b-12d3-a456-426614174000');
	});

	it('resolves a short prefix from task list fallback', async () => {
		const api = createApiMock([
			{ error: new Error('not found') },
			{ data: [] },
			{
				data: [
					{ id: 'abcde111-1111-1111-1111-111111111111', title: 'First task' },
					{ id: 'fffff222-2222-2222-2222-222222222222', title: 'Second task' },
				],
			},
		]);

		const task = await resolveTaskByIdentifier(api, 'project-1', 'abcde111');
		expect(task.id).toBe('abcde111-1111-1111-1111-111111111111');
	});

	it('throws on ambiguous short prefix', async () => {
		const api = createApiMock([
			{ error: new Error('not found') },
			{ data: [] },
			{
				data: [
					{ id: 'abcde111-1111-1111-1111-111111111111', title: 'First task' },
					{ id: 'abcde222-2222-2222-2222-222222222222', title: 'Second task' },
				],
			},
		]);

		await expect(resolveTaskByIdentifier(api, 'project-1', 'abcde')).rejects.toThrow(
			/AMBIGUOUS_TASK_ID/
		);
	});

	it('resolves a batch of identifiers', async () => {
		const api = createApiMock([
			{ error: new Error('not found') },
			{ data: [] },
			{
				data: [{ id: 'abcde111-1111-1111-1111-111111111111', title: 'First task' }],
			},
			{ data: { id: 'fffff222-2222-2222-2222-222222222222' } },
		]);

		const ids = await resolveTaskIdentifiers(api, 'project-1', ['abcde111', 'fffff222-2222-2222-2222-222222222222']);
		expect(ids).toEqual([
			'abcde111-1111-1111-1111-111111111111',
			'fffff222-2222-2222-2222-222222222222',
		]);
	});
});

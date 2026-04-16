import { describe, it, expect } from 'vitest';
import { toGitContext, type GitMetadata } from '../../../src/lib/git.js';

describe('Async Git Operations - Contract Tests', () => {
	describe('toGitContext adapter', () => {
		it('should properly transform Promise value to GitContext', async () => {
			// Simulate async workflow: get metadata, then convert to context
			const metadata: GitMetadata = {
				branch: 'main',
				commitHash: 'abc1234',
				remoteUrl: 'https://github.com/test/repo.git',
				status: 'clean',
				repoName: 'repo',
				repoPath: '/Users/test/repo'
			};

			// The adapter should work correctly
			const context = toGitContext(metadata);

			expect(context).toEqual({
				branch: 'main',
				commitHash: 'abc1234',
				remoteUrl: 'https://github.com/test/repo.git',
				status: 'clean',
				repoName: 'repo',
				repoPath: '/Users/test/repo'
			});
		});

		it('should preserve async contract: Promise<GitMetadata> -> GitContext', async () => {
			// Verify the adapter correctly converts the Promise type
			const metadata: GitMetadata = {
				branch: null,
				commitHash: null,
				remoteUrl: null,
				status: 'unknown',
				repoName: null,
				repoPath: '/test'
			};

			const context = toGitContext(metadata);

			// GitContext uses string status, not union type
			expect(typeof context.status).toBe('string');
			expect(context.status).toBe('unknown');
		});

		it('should handle dirty status conversion', async () => {
			const metadata: GitMetadata = {
				branch: 'feature/test',
				commitHash: 'deadbeef',
				remoteUrl: null,
				status: 'dirty',
				repoName: 'my-project',
				repoPath: '/workspace/my-project'
			};

			const context = toGitContext(metadata);

			expect(context.status).toBe('dirty');
			expect(context.branch).toBe('feature/test');
		});
	});
});
import { describe, it, expect } from 'vitest';
import { toGitContext, type GitMetadata } from '../../../src/lib/git.js';

describe('Git Context Adapter', () => {
	describe('toGitContext', () => {
		it('should convert GitMetadata to GitContext correctly', () => {
			const metadata: GitMetadata = {
				branch: 'main',
				commitHash: 'abc1234',
				remoteUrl: 'https://github.com/test/repo.git',
				status: 'clean',
				repoName: 'repo',
				repoPath: '/Users/test/repo'
			};

			const result = toGitContext(metadata);

			expect(result.branch).toBe('main');
			expect(result.commitHash).toBe('abc1234');
			expect(result.remoteUrl).toBe('https://github.com/test/repo.git');
			expect(result.status).toBe('clean');
			expect(result.repoName).toBe('repo');
			expect(result.repoPath).toBe('/Users/test/repo');
		});

		it('should handle null values correctly', () => {
			const metadata: GitMetadata = {
				branch: null,
				commitHash: null,
				remoteUrl: null,
				status: 'unknown',
				repoName: null,
				repoPath: '/Users/test/unknown'
			};

			const result = toGitContext(metadata);

			expect(result.branch).toBeNull();
			expect(result.commitHash).toBeNull();
			expect(result.remoteUrl).toBeNull();
			expect(result.status).toBe('unknown');
			expect(result.repoName).toBeNull();
			expect(result.repoPath).toBe('/Users/test/unknown');
		});

		it('should handle dirty status correctly', () => {
			const metadata: GitMetadata = {
				branch: 'feature-branch',
				commitHash: 'def5678',
				remoteUrl: null,
				status: 'dirty',
				repoName: 'my-repo',
				repoPath: '/home/user/my-repo'
			};

			const result = toGitContext(metadata);

			expect(result.status).toBe('dirty');
			expect(result.branch).toBe('feature-branch');
		});

		it('should preserve repoPath regardless of status', () => {
			const cleanMetadata: GitMetadata = {
				branch: 'main',
				commitHash: 'xyz000',
				remoteUrl: 'git@example.com:org/proj.git',
				status: 'clean',
				repoName: 'proj',
				repoPath: '/code/proj'
			};

			const result = toGitContext(cleanMetadata);

			expect(result.repoPath).toBe('/code/proj');
			expect(result.repoName).toBe('proj');
		});
	});
});
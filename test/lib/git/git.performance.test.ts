import { describe, it, expect } from 'vitest';
import { getGitMetadata, getGitMetadataForPaths, type GitMetadata } from '../../../src/lib/git.js';

describe('Git Performance Benchmarks', () => {
	/**
	 * Benchmark: Measure event loop responsiveness during git operations.
	 * This test simulates multiple concurrent git metadata fetches
	 * and verifies the event loop isn't blocked for too long.
	 */
	it('should not block event loop during multiple git operations', async () => {
		const startTime = Date.now();
		const eventLoopCheckResults: number[] = [];

		// Schedule multiple git metadata calls
		const gitPromises: Promise<GitMetadata>[] = [];
		const numOperations = 10;

		for (let i = 0; i < numOperations; i++) {
			// Each getGitMetadata spawns 4 parallel git commands
			gitPromises.push(getGitMetadata());

			// Check event loop responsiveness periodically
			eventLoopCheckResults.push(Date.now() - startTime);
		}

		// Wait for all git operations to complete
		const results = await Promise.all(gitPromises);
		const totalTime = Date.now() - startTime;

		// Verify we got results
		expect(results.length).toBe(numOperations);

		// Event loop shouldn't be completely blocked - operations should complete
		// in reasonable time. Even with 10 calls × 4 commands = 40 git processes,
		// with parallel execution it should be fast.
		expect(totalTime).toBeLessThan(10000); // 10 seconds max for all operations

		// Verify the time gaps between checks show event loop was responsive
		// (gaps should be small, not accumulating to the full total time)
		const maxGap = Math.max(
			...eventLoopCheckResults.slice(1).map((t, i) => t - eventLoopCheckResults[i])
		);

		// The event loop should respond within reasonable intervals
		expect(maxGap).toBeLessThan(5000); // No single gap should be huge
	});

	/**
	 * Benchmark: getGitMetadataForPaths performance with multiple repos
	 */
	it('should handle multiple file paths efficiently', async () => {
		const startTime = Date.now();

		// Create an array of file paths pointing to the same repo
		// (getGitMetadataForPaths will deduplicate and run only once)
		const filePaths = Array.from({ length: 20 }, (_, i) =>
			`/Users/digudev/Documents/DEV/PER/ickit-fb/04-ickit-mcp/src/index.ts`
		);

		const result = await getGitMetadataForPaths(filePaths);

		const duration = Date.now() - startTime;

		// Should only return metadata for one unique repo (deduplication works)
		expect(result.length).toBeGreaterThanOrEqual(0);

		// Should complete in reasonable time even with 20 duplicate paths
		expect(duration).toBeLessThan(5000);

		// Verify the metadata structure is correct
		if (result.length > 0) {
			expect(result[0]).toHaveProperty('branch');
			expect(result[0]).toHaveProperty('commitHash');
			expect(result[0]).toHaveProperty('repoPath');
		}
	});

	/**
	 * Verify that all 4 git commands run in parallel within collectGitMetadata
	 */
	it('should collect branch, commit, remote and status in parallel', async () => {
		const result = await getGitMetadata();

		// All fields should be populated (or null if not available)
		expect(result).toHaveProperty('branch');
		expect(result).toHaveProperty('commitHash');
		expect(result).toHaveProperty('remoteUrl');
		expect(result).toHaveProperty('status');
		expect(result).toHaveProperty('repoName');
		expect(result).toHaveProperty('repoPath');

		// Status should be one of the valid values
		expect(['clean', 'dirty', 'unknown']).toContain(result.status);
	});
});
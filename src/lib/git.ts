import { exec } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

/**
 * Cache for findGitRootForPath results.
 * Key: resolved directory path
 * Value: git root path or null if not found
 */
const gitRootCache = new Map<string, string | null>();

/**
 * Maximum cache entries to prevent unbounded growth.
 * Evict oldest entries when limit is reached.
 */
const MAX_CACHE_SIZE = 200;

/**
 * Evict oldest cache entry (simple FIFO eviction).
 */
function evictOldestCacheEntry(): void {
	const firstKey = gitRootCache.keys().next().value;
	if (firstKey !== undefined) {
		gitRootCache.delete(firstKey);
	}
}

/**
 * Internal GitMetadata representation - used for collection.
 */
export interface GitMetadata {
	branch: string | null;
	commitHash: string | null;
	remoteUrl: string | null;
	status: 'clean' | 'dirty' | 'unknown';
	repoName: string | null;
	repoPath: string;
}

/**
 * Unified Git Context contract for MCP tools.
 * This is the canonical interface used across the codebase.
 */
export interface GitContext {
	branch: string | null;
	commitHash: string | null;
	remoteUrl: string | null;
	status: string;
	repoName: string | null;
	repoPath: string;
}

/**
 * Convert internal GitMetadata to the unified GitContext contract.
 * Use this at boundary layers to maintain type safety.
 */
export function toGitContext(metadata: GitMetadata): GitContext {
	return {
		branch: metadata.branch,
		commitHash: metadata.commitHash,
		remoteUrl: metadata.remoteUrl,
		status: metadata.status,
		repoName: metadata.repoName,
		repoPath: metadata.repoPath
	};
}

async function runGit(args: string, cwd: string): Promise<string | null> {
	try {
		const { stdout } = await execAsync(`git ${args}`, {
			encoding: 'utf-8',
			timeout: 3000,
			cwd
		});
		return stdout.trim();
	} catch {
		return null;
	}
}

/**
 * Walk up from a file path to find the nearest .git directory.
 * Stops at the filesystem root.
 * Uses LRU-style memoization to avoid repeated filesystem walks.
 */
function findGitRootForPath(filePath: string): string | null {
	const resolvedPath = resolve(dirname(filePath));

	// Check cache first
	if (gitRootCache.has(resolvedPath)) {
		return gitRootCache.get(resolvedPath)!;
	}

	let current = resolvedPath;
	const root = '/';

	while (current !== root) {
		if (existsSync(join(current, '.git'))) {
			// Cache the result before returning
			ensureCacheCapacity();
			gitRootCache.set(resolvedPath, current);
			return current;
		}
		current = dirname(current);
	}

	// Check root itself
	if (existsSync(join(root, '.git'))) {
		ensureCacheCapacity();
		gitRootCache.set(resolvedPath, root);
		return root;
	}

	// Cache the negative result as well
	ensureCacheCapacity();
	gitRootCache.set(resolvedPath, null);
	return null;
}

/**
 * Ensure cache doesn't exceed max size by evicting oldest entries.
 */
function ensureCacheCapacity(): void {
	while (gitRootCache.size >= MAX_CACHE_SIZE) {
		evictOldestCacheEntry();
	}
}

/**
 * Find the nearest git repository by checking:
 * 1. Current working directory
 * 2. Immediate subdirectories (monorepo packages)
 * Returns the cwd to use for git commands, or undefined if none found.
 */
function findNearestGitRoot(): string | undefined {
	const cwd = process.cwd();

	// Check if CWD itself is a git repo
	if (existsSync(join(cwd, '.git'))) return cwd;

	// Check immediate subdirectories for .git (monorepo pattern)
	try {
		const entries = readdirSync(cwd, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isDirectory()) {
				const subPath = join(cwd, entry.name);
				if (existsSync(join(subPath, '.git'))) {
					return subPath;
				}
			}
		}
	} catch {
		// Ignore readdir errors
	}

	return undefined;
}

/**
 * Extract a human-friendly repo name from a path.
 * e.g. "/Users/me/project/02-ickit-fe" → "02-ickit-fe"
 */
function extractRepoName(repoPath: string): string {
	const parts = repoPath.split(/[/\\]/).filter(Boolean);
	return parts[parts.length - 1] || repoPath;
}

/**
 * Collect git metadata for a specific repository root.
 * Runs all git commands in parallel for better performance.
 */
async function collectGitMetadata(repoPath: string): Promise<GitMetadata> {
	// Run all git commands in parallel to avoid sequential blocking
	const [branch, commitHash, remoteUrl, statusOutput] = await Promise.all([
		runGit('rev-parse --abbrev-ref HEAD', repoPath),
		runGit('rev-parse --short HEAD', repoPath),
		runGit('config --get remote.origin.url', repoPath),
		runGit('status --porcelain', repoPath)
	]);

	let status: GitMetadata['status'] = 'unknown';
	if (statusOutput !== null) {
		status = statusOutput.length === 0 ? 'clean' : 'dirty';
	}

	return {
		branch,
		commitHash,
		remoteUrl,
		status,
		repoName: extractRepoName(repoPath),
		repoPath
	};
}

/**
 * Collect git metadata from the current working directory.
 * For monorepos, automatically detects the nearest git repo in subdirectories.
 * Returns null values for any field that cannot be resolved.
 * Never throws — always returns a safe result.
 *
 * @deprecated Use getGitMetadataForPaths for multi-repo support.
 */
export async function getGitMetadata(): Promise<GitMetadata> {
	const gitRoot = findNearestGitRoot();

	if (!gitRoot) {
		return {
			branch: null,
			commitHash: null,
			remoteUrl: null,
			status: 'unknown',
			repoName: null,
			repoPath: process.cwd()
		};
	}

	return collectGitMetadata(gitRoot);
}

/**
 * Find the git root for a specific file path by walking up the directory tree.
 * Returns null if no git repo is found.
 */
export function findGitRoot(filePath: string): string | null {
	return findGitRootForPath(filePath);
}

/**
 * Get git metadata for a single file path.
 * Walks up from the file's directory to find the nearest .git.
 */
export async function getGitMetadataForPath(filePath: string): Promise<GitMetadata | null> {
	const gitRoot = findGitRootForPath(filePath);
	if (!gitRoot) return null;
	return collectGitMetadata(gitRoot);
}

/**
 * Get git metadata for multiple file paths.
 * Deduplicates by repoPath so each repo appears only once.
 * Runs all repo collections in parallel for better performance.
 * Returns an array of unique GitMetadata objects.
 */
export async function getGitMetadataForPaths(filePaths: string[]): Promise<GitMetadata[]> {
	const repoMap = new Map<string, GitMetadata>();

	// Collect all git roots first (synchronous, fast)
	const gitRoots = new Set<string>();
	for (const filePath of filePaths) {
		const gitRoot = findGitRootForPath(filePath);
		if (gitRoot) gitRoots.add(gitRoot);
	}

	// Run all repo collections in parallel
	const metadataList = await Promise.all(
		Array.from(gitRoots).map((gitRoot) => collectGitMetadata(gitRoot))
	);

	// Build the map (deduplication is automatic since we used a Set)
	for (const metadata of metadataList) {
		repoMap.set(metadata.repoPath, metadata);
	}

	return Array.from(repoMap.values());
}

/**
 * Resolve which repos are affected by a set of changed files.
 * Groups files by their git root and returns metadata for each unique repo.
 *
 * @param changedFiles - Array of file paths that were modified
 * @returns Array of GitMetadata, one per affected repo
 */
export async function resolveAffectedRepos(changedFiles: string[]): Promise<GitMetadata[]> {
	return getGitMetadataForPaths(changedFiles);
}

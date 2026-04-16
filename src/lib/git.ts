import { exec } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

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
 */
function findGitRootForPath(filePath: string): string | null {
	let current = resolve(dirname(filePath));
	const root = '/';

	while (current !== root) {
		if (existsSync(join(current, '.git'))) {
			return current;
		}
		current = dirname(current);
	}

	// Check root itself
	if (existsSync(join(root, '.git'))) return root;

	return null;
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
 */
async function collectGitMetadata(repoPath: string): Promise<GitMetadata> {
	const branch = await runGit('rev-parse --abbrev-ref HEAD', repoPath);
	const commitHash = await runGit('rev-parse --short HEAD', repoPath);
	const remoteUrl = await runGit('config --get remote.origin.url', repoPath);
	const statusOutput = await runGit('status --porcelain', repoPath);

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
 * Returns an array of unique GitMetadata objects.
 */
export async function getGitMetadataForPaths(filePaths: string[]): Promise<GitMetadata[]> {
	const repoMap = new Map<string, GitMetadata>();

	for (const filePath of filePaths) {
		const gitRoot = findGitRootForPath(filePath);
		if (!gitRoot) continue;

		// Skip if we already have this repo
		if (repoMap.has(gitRoot)) continue;

		repoMap.set(gitRoot, await collectGitMetadata(gitRoot));
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

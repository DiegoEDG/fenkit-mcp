import { execSync } from 'node:child_process';

export interface GitMetadata {
	branch: string | null;
	commitHash: string | null;
	remoteUrl: string | null;
	status: 'clean' | 'dirty' | 'unknown';
}

function runGit(args: string): string | null {
	try {
		return execSync(`git ${args}`, {
			encoding: 'utf-8',
			timeout: 3000,
			stdio: ['ignore', 'pipe', 'ignore']
		}).trim();
	} catch {
		return null;
	}
}

/**
 * Collect git metadata from the current working directory.
 * Returns null values for any field that cannot be resolved.
 * Never throws — always returns a safe result.
 */
export function getGitMetadata(): GitMetadata {
	const branch = runGit('rev-parse --abbrev-ref HEAD');
	const commitHash = runGit('rev-parse --short HEAD');
	const remoteUrl = runGit('config --get remote.origin.url');
	const statusOutput = runGit('status --porcelain');

	let status: GitMetadata['status'] = 'unknown';
	if (statusOutput !== null) {
		status = statusOutput.length === 0 ? 'clean' : 'dirty';
	}

	return { branch, commitHash, remoteUrl, status };
}

interface WalkthroughCommitInput {
	taskId: string;
	summary: string;
	changes: string[];
	filesModified: string[];
}

function compactTaskId(taskId: string): string {
	const normalized = taskId.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
	if (normalized.length >= 5) return normalized.slice(0, 5);
	const fallback = taskId.trim().toLowerCase();
	return fallback.length >= 5 ? fallback.slice(0, 5) : fallback;
}

function inferCommitType(input: WalkthroughCommitInput): 'feat' | 'fix' | 'docs' | 'refactor' | 'test' | 'chore' {
	const text = [input.summary, ...input.changes, ...input.filesModified].join(' ').toLowerCase();

	if (/\bfix(?:ed|es|ing)?\b|\bbug\b|\berror\b|\bissue\b/.test(text)) return 'fix';
	if (/\brefactor(?:ed|ing)?\b|\brestructure(?:d|ing)?\b|\bcleanup\b|\bclean up\b/.test(text)) return 'refactor';
	if (/\btest(?:s|ed|ing)?\b|\bspec\b|\bcoverage\b/.test(text)) return 'test';

	const hasOnlyMarkdownFiles =
		input.filesModified.length > 0 && input.filesModified.every((file) => file.toLowerCase().endsWith('.md'));
	if (hasOnlyMarkdownFiles || /\bdocs?\b|\breadme\b|\bcomment(?:s)?\b/.test(text)) return 'docs';

	if (/\badd(?:ed|ing)?\b|\bcreate(?:d|ing)?\b|\bimplement(?:ed|ing)?\b|\bintroduc(?:e|ed|ing)\b|\bnew\b|\bsupport(?:ed|ing)?\b/.test(text)) {
		return 'feat';
	}

	return 'chore';
}

function inferCommitScope(filesModified: string[]): string | undefined {
	if (!filesModified.length) return undefined;

	const scopes = new Set<string>();
	for (const file of filesModified) {
		const parts = file.split('/').filter(Boolean);
		if (!parts.length) continue;

		const top = parts[0];
		const isMonoRepo = top === 'src' || top === 'apps' || top === 'packages' || top === 'lib';
		const candidate = isMonoRepo && parts[1] ? parts[1] : top;
		if (!candidate) continue;
		const sanitized = candidate.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
		if (sanitized) scopes.add(sanitized);
	}

	if (scopes.size !== 1) return undefined;
	const [scope] = [...scopes];
	if (!scope) return undefined;
	return scope.slice(0, 24);
}

function buildSubject(summary: string): string {
	const collapsed = summary.trim().replace(/\s+/g, ' ').replace(/[.:;\s]+$/, '');
	if (!collapsed) return 'update task walkthrough artifact';
	const withLowercaseFirst = collapsed.charAt(0).toLowerCase() + collapsed.slice(1);
	return withLowercaseFirst;
}

export function buildSuggestedGitCommit(input: WalkthroughCommitInput): string {
	const type = inferCommitType(input);
	const scope = inferCommitScope(input.filesModified);
	const subject = buildSubject(input.summary);
	const taskId = compactTaskId(input.taskId);

	const commitPrefix = scope ? `${type}(${scope})` : type;
	if (!taskId) return `${commitPrefix}: ${subject}`;
	return `${commitPrefix}: ${subject} (${taskId})`;
}

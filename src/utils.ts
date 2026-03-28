import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { ExecutionMetadata } from './schemas.js';

/**
 * Strips <private>...</private> tags from content before returning to LLM.
 * PRD Section 10: Security & Privacy — Redaction
 */
export function stripPrivate(content: string): string {
	return content.replace(/<private>[\s\S]*?<\/private>/gi, '[REDACTED]');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursively strips private tags from any string values in objects/arrays.
 */
export function stripPrivateDeep(value: unknown): unknown {
	if (typeof value === 'string') {
		return stripPrivate(value);
	}

	if (Array.isArray(value)) {
		return value.map((item) => stripPrivateDeep(item));
	}

	if (isPlainObject(value)) {
		const output: Record<string, unknown> = {};
		for (const [key, nested] of Object.entries(value)) {
			output[key] = stripPrivateDeep(nested);
		}
		return output;
	}

	return value;
}

export function truncateDeterministic(content: string, maxChars: number): string {
	if (content.length <= maxChars) return content;
	return `${content.slice(0, maxChars)}\n...[truncated at ${maxChars} chars]`;
}

/**
 * Determines the AI provider from a model name string.
 * Mirrors CLI logic in getProvider().
 */
export function getProvider(model?: string): string {
	if (!model) return 'unknown';
	const m = model.toLowerCase();
	if (m.includes('claude')) return 'anthropic';
	if (m.includes('gpt')) return 'openai';
	if (m.includes('gemini')) return 'google';
	if (m.includes('llama')) return 'meta';
	if (m.includes('mistral')) return 'mistral';
	return 'unknown';
}

/**
 * Gathers git info (commit, branch, diff stats).
 * Mirrors CLI logic in getGitInfo().
 */
export function getGitInfo(): Record<string, unknown> | null {
	const execGit = (command: string): string | undefined => {
		try {
			const output = execSync(command, {
				stdio: ['ignore', 'pipe', 'ignore']
			})
				.toString()
				.trim();
			return output.length > 0 ? output : undefined;
		} catch {
			return undefined;
		}
	};

	const isRepo = execGit('git rev-parse --is-inside-work-tree') === 'true';
	if (!isRepo) {
		return {
			repo: 'unknown',
			commit: 'unknown',
			branch: 'unknown',
			metrics: {
				filesChanged: 0,
				linesAdded: 0,
				linesDeleted: 0
			}
		};
	}

	const repoRoot = execGit('git rev-parse --show-toplevel');
	const repo = execGit('git config --get remote.origin.url') ?? (repoRoot ? path.basename(repoRoot) : 'unknown');
	const commit = execGit('git rev-parse HEAD') ?? 'unknown';
	const branch = execGit('git rev-parse --abbrev-ref HEAD') ?? 'unknown';
	const shortstat = execGit('git diff --shortstat') ?? '';

	const filesChangedMatch = shortstat.match(/(\d+)\s+files?\s+changed/);
	const insertionsMatch = shortstat.match(/(\d+)\s+insertions?\(\+\)/);
	const deletionsMatch = shortstat.match(/(\d+)\s+deletions?\(-\)/);

	return {
		repo,
		commit,
		branch,
		metrics: {
			filesChanged: filesChangedMatch ? parseInt(filesChangedMatch[1], 10) : 0,
			linesAdded: insertionsMatch ? parseInt(insertionsMatch[1], 10) : 0,
			linesDeleted: deletionsMatch ? parseInt(deletionsMatch[1], 10) : 0
		}
	};
}

/**
 * Builds execution metadata for write operations.
 * Mirrors CLI buildMetadata() adapted for MCP usage.
 * PRD Section 8.2: Every write MUST include execution_metadata.
 */
export function buildExecutionMetadata(
	content: string,
	options?: {
		model?: string;
		agent?: string;
		lastRetrievedAt?: string;
		sessionId?: string;
		chatId?: string;
		chatName?: string;
		tokenSource?: 'exact' | 'estimate' | 'mixed';
		extraTokens?: { input?: number; output?: number; total?: number };
	}
): ExecutionMetadata & Record<string, unknown> {
	const nowIso = new Date().toISOString();
	let durationMs: number | undefined;
	if (options?.lastRetrievedAt) {
		const start = new Date(options.lastRetrievedAt).getTime();
		durationMs = Date.now() - start;
	}

	const provider = getProvider(options?.model);

	return {
		timestamp: nowIso,
		executed_at: nowIso,
		durationMs: durationMs ?? 0,
		agent: options?.agent || 'mcp-server',
		agent_client: options?.agent || 'mcp-server',
		model: options?.model || 'unknown',
		provider,
		tokens: {
			estimate: Math.ceil(content.length / 4),
			...options?.extraTokens
		},
		token_source: options?.tokenSource,
		session_id: options?.sessionId,
		chat_id: options?.chatId,
		chat_name: options?.chatName,
		chat_title: options?.chatName || 'Unknown chat',
		git: getGitInfo(),
		env: {
			os: os.platform(),
			node: process.version
		}
	};
}

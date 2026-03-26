import os from 'node:os';
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
	try {
		const commit = execSync('git rev-parse HEAD', {
			stdio: ['ignore', 'pipe', 'ignore']
		})
			.toString()
			.trim();
		const branch = execSync('git rev-parse --abbrev-ref HEAD', {
			stdio: ['ignore', 'pipe', 'ignore']
		})
			.toString()
			.trim();

		const stats = execSync('git diff --stat', {
			stdio: ['ignore', 'pipe', 'ignore']
		})
			.toString()
			.trim();

		const filesChanged = stats ? stats.split('\n').length - 1 : 0;
		const linesMatch = stats.match(/(\d+) insertion.*(\d+) deletion/);
		const insertions = linesMatch ? parseInt(linesMatch[1]) : 0;
		const deletions = linesMatch ? parseInt(linesMatch[2]) : 0;

		return {
			commit,
			branch,
			metrics: {
				filesChanged: filesChanged > 0 ? filesChanged : 0,
				linesAdded: insertions,
				linesDeleted: deletions
			}
		};
	} catch {
		return null;
	}
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
		extraTokens?: { input?: number; output?: number; total?: number };
	}
): ExecutionMetadata & Record<string, unknown> {
	let durationMs: number | undefined;
	if (options?.lastRetrievedAt) {
		const start = new Date(options.lastRetrievedAt).getTime();
		durationMs = Date.now() - start;
	}

	const provider = getProvider(options?.model);

	return {
		timestamp: new Date().toISOString(),
		durationMs,
		agent: options?.agent || 'mcp-server',
		model: options?.model,
		provider,
		tokens: {
			estimate: Math.ceil(content.length / 4),
			...options?.extraTokens
		},
		git: getGitInfo(),
		env: {
			os: os.platform(),
			node: process.version
		}
	};
}

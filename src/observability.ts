import { createHash } from 'node:crypto';

type JsonObject = Record<string, unknown>;

interface ToolMetrics {
	calls: number;
	success: number;
	errors: number;
	duplicatesAvoided: number;
	retries: number;
	totalLatencyMs: number;
}

const metrics = new Map<string, ToolMetrics>();

function isRecord(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneJsonSafe<T>(value: T): T {
	try {
		return JSON.parse(JSON.stringify(value)) as T;
	} catch {
		return value;
	}
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((item) => canonicalize(item));
	if (isRecord(value)) {
		const out: JsonObject = {};
		for (const key of Object.keys(value).sort()) {
			out[key] = canonicalize(value[key]);
		}
		return out;
	}
	return value;
}

export function stableHash(value: unknown): string {
	const serialized = JSON.stringify(canonicalize(value));
	return createHash('sha256').update(serialized || 'null').digest('hex');
}

export function extractPromptFromHeaders(headers: unknown): string | undefined {
	if (!isRecord(headers)) return undefined;
	const candidates = [
		'x-user-prompt',
		'x-prompt',
		'x-codex-prompt',
		'x-thread-prompt',
		'prompt'
	];
	for (const key of candidates) {
		const value = headers[key];
		if (typeof value === 'string' && value.trim().length > 0) return value.trim();
		if (Array.isArray(value)) {
			const first = value.find((item) => typeof item === 'string' && item.trim().length > 0);
			if (typeof first === 'string') return first.trim();
		}
	}
	return undefined;
}

function getMetric(tool: string): ToolMetrics {
	const existing = metrics.get(tool);
	if (existing) return existing;
	const created: ToolMetrics = {
		calls: 0,
		success: 0,
		errors: 0,
		duplicatesAvoided: 0,
		retries: 0,
		totalLatencyMs: 0
	};
	metrics.set(tool, created);
	return created;
}

export function trackToolCall(event: {
	tool: string;
	input?: unknown;
	output?: unknown;
	error?: string;
	latencyMs: number;
	duplicateAvoided?: boolean;
	retries?: number;
	chatId?: string;
	prompt?: string;
	sessionId?: string;
}): void {
	const stat = getMetric(event.tool);
	stat.calls += 1;
	stat.totalLatencyMs += event.latencyMs;
	stat.retries += Math.max(0, event.retries || 0);
	if (event.duplicateAvoided) stat.duplicatesAvoided += 1;
	if (event.error) stat.errors += 1;
	else stat.success += 1;

	const line: JsonObject = {
		ts: new Date().toISOString(),
		tool: event.tool,
		input: cloneJsonSafe(event.input),
		output: cloneJsonSafe(event.output),
		error: event.error,
		latencyMs: event.latencyMs,
		duplicateAvoided: !!event.duplicateAvoided,
		retries: event.retries || 0,
		chatId: event.chatId,
		prompt: event.prompt,
		session_id: event.sessionId
	};

	console.error(`[fenkit-observe] ${JSON.stringify(line)}`);
}

export function getToolMetricsSnapshot(): Record<string, JsonObject> {
	const output: Record<string, JsonObject> = {};
	for (const [tool, value] of metrics.entries()) {
		output[tool] = {
			calls: value.calls,
			success: value.success,
			errors: value.errors,
			successRate: value.calls > 0 ? Number((value.success / value.calls).toFixed(4)) : 0,
			averageLatencyMs: value.calls > 0 ? Number((value.totalLatencyMs / value.calls).toFixed(2)) : 0,
			retries: value.retries,
			duplicatesAvoided: value.duplicatesAvoided
		};
	}
	return output;
}

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

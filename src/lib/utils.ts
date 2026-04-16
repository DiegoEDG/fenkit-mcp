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
 * Conditionally includes a property in an object only if value is not undefined.
 * Use this with exactOptionalPropertyTypes to avoid passing explicit undefined.
 *
 * @example
 * // Instead of { actor: options.actor } which passes undefined
 * const obj = { ...withOptional('actor', options.actor) }
 * // Result: { actor: 'value' } or {} when actor is undefined
 */
export function withOptional<T>(key: string, value: T): Record<string, never> | { [K in keyof { [key: string]: T }]: T } {
	if (value !== undefined) {
		return { [key]: value };
	}
	return {} as Record<string, never>;
}

/**
 * Builds an object from multiple optional entries, omitting undefined values.
 * Useful for constructing API payloads with exactOptionalPropertyTypes.
 *
 * @example
 * const payload = withOptionalEntries({
 *   actor: options.actor,
 *   ttlMs: options.ttlMs,
 *   status: options.status
 * });
 */
export function withOptionalEntries<T extends Record<string, unknown>>(entries: T): Partial<T> {
	const result: Partial<T> = {};
	for (const [key, value] of Object.entries(entries)) {
		if (value !== undefined) {
			(result as Record<string, unknown>)[key] = value;
		}
	}
	return result;
}

/**
 * Alias for backward compatibility - prefer withOptional
 * @deprecated Use withOptional instead
 */
export function conditionalSpread<T>(key: string, value: T): Record<string, never> | { [K in keyof { [key: string]: T }]: T } {
	return withOptional(key, value);
}

/**
 * Alias for backward compatibility - prefer withOptionalEntries
 * @deprecated Use withOptionalEntries instead
 */
export function buildOptionalObject<T extends Record<string, unknown>>(entries: T): Partial<T> {
	return withOptionalEntries(entries);
}

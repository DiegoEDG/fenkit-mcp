import { stripPrivate, truncateDeterministic } from './utils.js';

export const DEFAULT_MAX_CHARS = 3500;
export const MAX_ALLOWED_CHARS = 12000;
export const MIN_ALLOWED_CHARS = 500;

export function clampMaxChars(value: number | undefined): number {
	if (typeof value !== 'number' || Number.isNaN(value)) return DEFAULT_MAX_CHARS;
	return Math.min(MAX_ALLOWED_CHARS, Math.max(MIN_ALLOWED_CHARS, Math.floor(value)));
}

export function compactNarrative(content: string | null | undefined, maxChars: number): string {
	if (!content) return '';
	return truncateDeterministic(stripPrivate(content), maxChars);
}

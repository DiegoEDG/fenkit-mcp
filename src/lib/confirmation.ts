import { randomUUID } from 'node:crypto';
import { withOptional } from './utils.js';

interface ConfirmationRecord {
	id: string;
	token: string;
	tool: string;
	payloadHash: string;
	scope: string;
	actor?: string;
	expiresAt: number;
	issuedAt: number;
}

interface IssueTokenOptions {
	tool: string;
	payloadHash: string;
	scope: string;
	actor?: string;
	ttlMs?: number;
}

interface ConsumeTokenOptions {
	token: string;
	tool: string;
	payloadHash: string;
	scope: string;
	actor?: string;
}

const DEFAULT_CONFIRMATION_TTL_MS = 2 * 60 * 1000;
const MAX_STORE_SIZE = 5000;
const store = new Map<string, ConfirmationRecord>();

function cleanupExpired(): void {
	const now = Date.now();
	for (const [token, record] of store.entries()) {
		if (record.expiresAt <= now) store.delete(token);
	}
	while (store.size > MAX_STORE_SIZE) {
		const first = store.keys().next();
		if (first.done) break;
		store.delete(first.value);
	}
}

export function isSensitiveConfirmationEnabled(): boolean {
	return process.env['FENKIT_REQUIRE_CONFIRMATION'] === 'true';
}

export function issueConfirmationToken(options: IssueTokenOptions): {
	token: string;
	tokenId: string;
	expiresAt: string;
	ttlSeconds: number;
} {
	cleanupExpired();
	const now = Date.now();
	const ttlMs = Math.max(5000, options.ttlMs ?? DEFAULT_CONFIRMATION_TTL_MS);
	const record: ConfirmationRecord = {
		id: randomUUID(),
		token: randomUUID(),
		tool: options.tool,
		payloadHash: options.payloadHash,
		scope: options.scope,
		...withOptional('actor', options.actor),
		issuedAt: now,
		expiresAt: now + ttlMs
	};
	store.set(record.token, record);
	return {
		token: record.token,
		tokenId: record.id,
		expiresAt: new Date(record.expiresAt).toISOString(),
		ttlSeconds: Math.floor(ttlMs / 1000)
	};
}

export function consumeConfirmationToken(options: ConsumeTokenOptions): {
	tokenId: string;
	confirmedAt: string;
	requestedAt: string;
} {
	cleanupExpired();
	const record = store.get(options.token);
	if (!record) throw new Error('CONFIRMATION_TOKEN_INVALID: Missing or already consumed token.');
	store.delete(options.token);

	if (record.expiresAt <= Date.now()) {
		throw new Error('CONFIRMATION_TOKEN_EXPIRED: Token expired, request a new preview.');
	}
	if (record.tool !== options.tool) {
		throw new Error('CONFIRMATION_TOKEN_MISMATCH: Token tool does not match this operation.');
	}
	if (record.payloadHash !== options.payloadHash) {
		throw new Error('CONFIRMATION_TOKEN_MISMATCH: Token payload hash does not match current payload.');
	}
	if (record.scope !== options.scope) {
		throw new Error('CONFIRMATION_TOKEN_MISMATCH: Token scope does not match current target.');
	}
	if (record.actor && options.actor && record.actor !== options.actor) {
		throw new Error('CONFIRMATION_TOKEN_MISMATCH: Token actor does not match current actor.');
	}

	return {
		tokenId: record.id,
		confirmedAt: new Date().toISOString(),
		requestedAt: new Date(record.issuedAt).toISOString()
	};
}

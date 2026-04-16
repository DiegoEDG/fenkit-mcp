import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type LocalIdempotencyStatus = 'none' | 'duplicate_replayed' | 'idempotency_conflict';

interface OperationRecord {
	tool: string;
	operation_id: string;
	payload_hash: string;
	recorded_at: string;
}

interface OperationIndex {
	operations: OperationRecord[];
}

const FENKIT_DIR = path.join(os.homedir(), '.fnk');
const OPS_FILE = path.join(FENKIT_DIR, 'mcp-local-ops.json');
const AUDIT_LOG = path.join(FENKIT_DIR, 'mcp-local-audit.log');
const MAX_INDEX_ENTRIES = 2000;

// In-memory cache for operation index to avoid repeated disk reads
let indexCache: OperationIndex | null = null;

async function ensureFenkitDirAsync(): Promise<void> {
	try {
		await fs.mkdir(FENKIT_DIR, { recursive: true, mode: 0o700 });
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
	}
}

/**
 * Load operation index with caching.
 * Uses in-memory cache to avoid repeated disk I/O in batch operations.
 */
async function loadIndexAsync(): Promise<OperationIndex> {
	if (indexCache) {
		return { ...indexCache, operations: [...indexCache.operations] };
	}

	await ensureFenkitDirAsync();

	try {
		const raw = await fs.readFile(OPS_FILE, 'utf-8');
		const parsed = JSON.parse(raw) as OperationIndex;
		indexCache = {
			operations: Array.isArray(parsed.operations) ? parsed.operations : []
		};
	} catch {
		indexCache = { operations: [] };
	}

	return { ...indexCache, operations: [...indexCache!.operations] };
}

/**
 * Save operation index.
 * Marks cache as dirty to trigger write on next load.
 */
async function saveIndexAsync(index: OperationIndex): Promise<void> {
	await ensureFenkitDirAsync();

	const compact = index.operations.slice(-MAX_INDEX_ENTRIES);
	await fs.writeFile(OPS_FILE, JSON.stringify({ operations: compact }, null, 2), 'utf-8');

	// Update cache after write
	indexCache = { operations: [...compact] };
}

/**
 * Async version of checkLocalIdempotency.
 * Uses cached index to avoid disk I/O.
 */
export async function checkLocalIdempotencyAsync(
	tool: string,
	operationId: string,
	payloadHash: string
): Promise<LocalIdempotencyStatus> {
	const index = await loadIndexAsync();
	const match = index.operations.find(
		(op) => op.tool === tool && op.operation_id === operationId
	);
	if (!match) return 'none';
	if (match.payload_hash === payloadHash) return 'duplicate_replayed';
	return 'idempotency_conflict';
}

/**
 * Async version of recordLocalOperation.
 * Updates cache and schedules write.
 */
export async function recordLocalOperationAsync(
	tool: string,
	operationId: string,
	payloadHash: string
): Promise<void> {
	const index = await loadIndexAsync();
	index.operations.push({
		tool,
		operation_id: operationId,
		payload_hash: payloadHash,
		recorded_at: new Date().toISOString()
	});
	await saveIndexAsync(index);
}

/**
 * Async version of appendLocalAuditLog.
 * Uses async file append to avoid blocking event loop.
 */
export async function appendLocalAuditLogAsync(event: Record<string, unknown>): Promise<void> {
	await ensureFenkitDirAsync();
	const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
	await fs.appendFile(AUDIT_LOG, `${line}\n`, 'utf-8');
}

// === Synchronous versions (for startup/initialization only) ===

function ensureFenkitDirSync(): void {
	if (!fsSync.existsSync(FENKIT_DIR)) fsSync.mkdirSync(FENKIT_DIR, { recursive: true, mode: 0o700 });
}

function loadIndexSync(): OperationIndex {
	ensureFenkitDirSync();
	try {
		const raw = fsSync.readFileSync(OPS_FILE, 'utf-8');
		const parsed = JSON.parse(raw) as OperationIndex;
		if (!Array.isArray(parsed.operations)) return { operations: [] };
		return parsed;
	} catch {
		return { operations: [] };
	}
}

function saveIndexSync(index: OperationIndex): void {
	ensureFenkitDirSync();
	const compact = index.operations.slice(-MAX_INDEX_ENTRIES);
	fsSync.writeFileSync(OPS_FILE, JSON.stringify({ operations: compact }, null, 2), 'utf-8');
}

/**
 * Synchronous version for backward compatibility.
 * Use only at startup or for one-off operations.
 */
export function checkLocalIdempotency(
	tool: string,
	operationId: string,
	payloadHash: string
): LocalIdempotencyStatus {
	// Invalidate cache on sync access
	indexCache = null;
	const index = loadIndexSync();
	const match = index.operations.find(
		(op) => op.tool === tool && op.operation_id === operationId
	);
	if (!match) return 'none';
	if (match.payload_hash === payloadHash) return 'duplicate_replayed';
	return 'idempotency_conflict';
}

/**
 * Synchronous version for backward compatibility.
 * Use only at startup or for one-off operations.
 */
export function recordLocalOperation(
	tool: string,
	operationId: string,
	payloadHash: string
): void {
	const index = loadIndexSync();
	index.operations.push({
		tool,
		operation_id: operationId,
		payload_hash: payloadHash,
		recorded_at: new Date().toISOString()
	});
	saveIndexSync(index);
}

/**
 * Synchronous version for backward compatibility.
 * Use only at startup or for one-off operations.
 */
export function appendLocalAuditLog(event: Record<string, unknown>): void {
	ensureFenkitDirSync();
	const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
	fsSync.appendFileSync(AUDIT_LOG, `${line}\n`, 'utf-8');
}

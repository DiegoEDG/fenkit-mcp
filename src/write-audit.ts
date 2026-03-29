import fs from 'node:fs';
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

function ensureFenkitDir(): void {
	if (!fs.existsSync(FENKIT_DIR)) fs.mkdirSync(FENKIT_DIR, { recursive: true, mode: 0o700 });
}

function loadIndex(): OperationIndex {
	ensureFenkitDir();
	if (!fs.existsSync(OPS_FILE)) return { operations: [] };
	try {
		const parsed = JSON.parse(fs.readFileSync(OPS_FILE, 'utf-8')) as OperationIndex;
		if (!Array.isArray(parsed.operations)) return { operations: [] };
		return parsed;
	} catch {
		return { operations: [] };
	}
}

function saveIndex(index: OperationIndex): void {
	ensureFenkitDir();
	const compact = index.operations.slice(-MAX_INDEX_ENTRIES);
	fs.writeFileSync(OPS_FILE, JSON.stringify({ operations: compact }, null, 2), 'utf-8');
}

export function checkLocalIdempotency(
	tool: string,
	operationId: string,
	payloadHash: string
): LocalIdempotencyStatus {
	const index = loadIndex();
	const match = index.operations.find(
		(op) => op.tool === tool && op.operation_id === operationId
	);
	if (!match) return 'none';
	if (match.payload_hash === payloadHash) return 'duplicate_replayed';
	return 'idempotency_conflict';
}

export function recordLocalOperation(
	tool: string,
	operationId: string,
	payloadHash: string
): void {
	const index = loadIndex();
	index.operations.push({
		tool,
		operation_id: operationId,
		payload_hash: payloadHash,
		recorded_at: new Date().toISOString()
	});
	saveIndex(index);
}

export function appendLocalAuditLog(event: Record<string, unknown>): void {
	ensureFenkitDir();
	const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
	fs.appendFileSync(AUDIT_LOG, `${line}\n`, 'utf-8');
}

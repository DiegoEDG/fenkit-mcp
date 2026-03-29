import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VALID = new Set(['read', 'write', 'admin']);

function main() {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
	const sourcePath = path.join(root, 'src', 'tool-capabilities.ts');
	const content = fs.readFileSync(sourcePath, 'utf-8');
	const regex = /^\s*([a-zA-Z0-9_]+):\s*'([a-z-]+)'/gm;
	const seen = new Set();
	const parsed = [];
	let match = regex.exec(content);
	while (match) {
		const tool = match[1];
		const capability = match[2];
		if (seen.has(tool)) {
			throw new Error(`Duplicate tool capability mapping for "${tool}"`);
		}
		if (!VALID.has(capability)) {
			throw new Error(`Invalid capability "${capability}" for "${tool}"`);
		}
		seen.add(tool);
		parsed.push({ tool, capability });
		match = regex.exec(content);
	}
	if (parsed.length === 0) {
		throw new Error('No capability mappings found.');
	}
	const readCount = parsed.filter((item) => item.capability === 'read').length;
	const writeCount = parsed.filter((item) => item.capability === 'write').length;
	console.log(`tool-capability-registry OK · read=${readCount} write=${writeCount}`);
}

try {
	main();
} catch (error) {
	console.error('tool-capability-registry FAILED', error);
	process.exit(1);
}

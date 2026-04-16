/**
 * Validates that capability registry keys match real tool registrations.
 * Parses registered tool names from source files and compares with tool-capabilities.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = path.join('src', 'tools');
const CAPABILITY_FILE = path.join('src', 'lib', 'tool-capabilities.ts');

function extractRegisteredTools(root) {
	const toolsPath = path.join(root, TOOLS_DIR);
	if (!fs.existsSync(toolsPath)) {
		throw new Error(`Tools directory not found: ${toolsPath}`);
	}

	const toolNames = new Set();
	const files = fs.readdirSync(toolsPath).filter(f => f.endsWith('.ts') && !f.includes('.test.'));

	for (const file of files) {
		const content = fs.readFileSync(path.join(toolsPath, file), 'utf-8');
		// Match server.tool('tool_name', ...)
		const regex = /server\.tool\(\s*['"]([a-zA-Z0-9_]+)['"]/g;
		let match;
		while ((match = regex.exec(content)) !== null) {
			toolNames.add(match[1]);
		}
	}

	if (toolNames.size === 0) {
		throw new Error('No registered tools found in source files.');
	}

	return toolNames;
}

function extractCapabilityRegistryKeys(root) {
	const capabilityPath = path.join(root, CAPABILITY_FILE);
	if (!fs.existsSync(capabilityPath)) {
		throw new Error(`Capability file not found: ${capabilityPath}`);
	}

	const content = fs.readFileSync(capabilityPath, 'utf-8');
	const toolNames = new Set();

	// Match lines like "tool_name: 'read'"
	const regex = /^\s*([a-zA-Z0-9_]+):\s*'(read|write|admin)'/gm;
	let match;
	while ((match = regex.exec(content)) !== null) {
		toolNames.add(match[1]);
	}

	if (toolNames.size === 0) {
		throw new Error('No capability mappings found in tool-capabilities.ts');
	}

	return toolNames;
}

function diffSets(setA, setB) {
	// setA = registry keys, setB = registered tools
	const onlyInRegistry = new Set(setA);
	const onlyInSource = new Set(setB);
	const intersection = new Set();

	for (const item of setA) {
		if (setB.has(item)) {
			onlyInRegistry.delete(item);
			onlyInSource.delete(item);
			intersection.add(item);
		}
	}

	return { onlyInRegistry, onlyInSource, intersection };
}

function main() {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

	console.log('🔍 Validating capability registry against registered tools...\n');

	const registeredTools = extractRegisteredTools(root);
	const registryKeys = extractCapabilityRegistryKeys(root);

	const { onlyInRegistry, onlyInSource, intersection } = diffSets(registryKeys, registeredTools);

	console.log(`  Registered tools: ${registeredTools.size}`);
	console.log(`  Registry keys:    ${registryKeys.size}`);
	console.log(`  In both:          ${intersection.size}\n`);

	if (onlyInRegistry.size > 0) {
		console.log('❌ Registry keys NOT in source (missing in registered tools):');
		for (const tool of [...onlyInRegistry].sort()) {
			console.log(`   - ${tool}`);
		}
		console.log('');
	}

	if (onlyInSource.size > 0) {
		console.log('❌ Source tools NOT in registry (capability undefined):');
		for (const tool of [...onlyInSource].sort()) {
			console.log(`   - ${tool}`);
		}
		console.log('');
	}

	if (onlyInRegistry.size === 0 && onlyInSource.size === 0) {
		console.log('✅ Capability registry matches registered tools exactly.');
		process.exit(0);
	} else {
		console.log('❌ Registry drift detected!');
		process.exit(1);
	}
}

try {
	main();
} catch (error) {
	console.error('Validation error:', error.message);
	process.exit(1);
}
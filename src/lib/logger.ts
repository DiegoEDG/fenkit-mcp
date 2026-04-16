import { inspect } from 'node:util';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40
};

function normalizeLogLevel(value: string | undefined): LogLevel {
	if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') return value;
	return 'info';
}

function serializeLogValue(value: unknown): string {
	if (typeof value === 'string') return value;
	if (value instanceof Error) {
		if (value.stack && value.stack.trim().length > 0) return value.stack;
		return `${value.name}: ${value.message}`;
	}
	return inspect(value, { depth: 5, breakLength: Infinity, compact: true });
}

function shouldLog(messageLevel: LogLevel): boolean {
	const configuredLevel = normalizeLogLevel(process.env.FENKIT_LOG_LEVEL);
	return LOG_LEVEL_PRIORITY[messageLevel] >= LOG_LEVEL_PRIORITY[configuredLevel];
}

function writeLog(level: LogLevel, scope: string, message: string, values: unknown[]): void {
	if (!shouldLog(level)) return;

	const serializedValues = values.map((value) => serializeLogValue(value));
	const output = [`[fenkit:${scope}]`, `[${level.toUpperCase()}]`, message, ...serializedValues]
		.filter((item) => item.length > 0)
		.join(' ');

	process.stderr.write(`${output}\n`);
}

export interface Logger {
	debug: (message: string, ...values: unknown[]) => void;
	info: (message: string, ...values: unknown[]) => void;
	warn: (message: string, ...values: unknown[]) => void;
	error: (message: string, ...values: unknown[]) => void;
}

export function createLogger(scope: string): Logger {
	return {
		debug: (message: string, ...values: unknown[]) => writeLog('debug', scope, message, values),
		info: (message: string, ...values: unknown[]) => writeLog('info', scope, message, values),
		warn: (message: string, ...values: unknown[]) => writeLog('warn', scope, message, values),
		error: (message: string, ...values: unknown[]) => writeLog('error', scope, message, values)
	};
}

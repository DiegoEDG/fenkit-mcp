import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { formatApiError } from './api.js';

interface McpErrorContext {
	toolName?: string;
	extraData?: Record<string, unknown>;
}

const SERIALIZATION_ERROR_PATTERNS = [
	'circular structure',
	'failed to serialize',
	'could not serialize',
	'do not know how to serialize a bigint',
	'cannot serialize',
	'stringify'
];

function isLikelyPayloadSerializationError(error: Error): boolean {
	const message = error.message.toLowerCase();
	return SERIALIZATION_ERROR_PATTERNS.some((pattern) => message.includes(pattern));
}

function mapAppCodeToMcpCode(appCode: string): ErrorCode {
	switch (appCode) {
		case 'NOT_AUTHENTICATED':
		case 'NO_ACTIVE_PROJECT':
		case 'TASK_NOT_FOUND':
			return ErrorCode.InvalidRequest;
		default:
			return ErrorCode.InternalError;
	}
}

export function toMcpError(error: unknown, context: McpErrorContext = {}): McpError {
	if (error instanceof McpError) return error;

	if (error instanceof Error && isLikelyPayloadSerializationError(error)) {
		const prefix = context.toolName ? `${context.toolName}: ` : '';
		return new McpError(
			ErrorCode.InternalError,
			`${prefix}PAYLOAD_SERIALIZATION_ERROR: Tool response payload could not be serialized. ${error.message}`,
			{
				appCode: 'PAYLOAD_SERIALIZATION_ERROR',
				...context.extraData,
			}
		);
	}

	const normalized = formatApiError(error);
	const prefix = context.toolName ? `${context.toolName}: ` : '';

	return new McpError(
		mapAppCodeToMcpCode(normalized.code),
		`${prefix}${normalized.code}: ${normalized.message}`,
		{
			appCode: normalized.code,
			...context.extraData,
		}
	);
}

export function throwAsMcpError(error: unknown, context: McpErrorContext = {}): never {
	throw toMcpError(error, context);
}

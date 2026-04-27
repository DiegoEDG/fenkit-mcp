import axios, { AxiosInstance } from 'axios';
import { createLogger } from './logger.js';

const BRIDGE_BASE_URL = process.env.FENKIT_INSIGHTS_BRIDGE_URL || 'http://localhost:7438';

let bridgeClient: AxiosInstance | null = null;
const logger = createLogger('bridge-client');

export function getBridgeClient(): AxiosInstance {
	if (bridgeClient) return bridgeClient;

	bridgeClient = axios.create({
		baseURL: BRIDGE_BASE_URL,
		timeout: 10000,
		headers: {
			'Content-Type': 'application/json',
		},
	});

	bridgeClient.interceptors.request.use((config) => {
		logger.debug('Bridge request', {
			method: config.method,
			url: config.url,
		});
		return config;
	});

	bridgeClient.interceptors.response.use(
		(response) => response,
		(error) => {
			if (error.code === 'ECONNREFUSED') {
				logger.warn('Bridge connection refused — is the bridge running?');
			}
			return Promise.reject(error);
		}
	);

	return bridgeClient;
}

export function formatBridgeError(error: unknown): { code: string; message: string } {
	if (axios.isAxiosError(error)) {
		if (error.code === 'ECONNREFUSED') {
			return {
				code: 'BRIDGE_UNAVAILABLE',
				message: 'Insights bridge is not running. Run `fenkit-insights run` to start it.',
			};
		}
		if (error.response) {
			const status = error.response.status;
			const message = (error.response.data as Record<string, string>)?.error || error.message;
			return {
				code: 'BRIDGE_ERROR',
				message: `Bridge error (${status}): ${message}`,
			};
		}
		return {
			code: 'BRIDGE_ERROR',
			message: `Bridge network error: ${error.message}`,
		};
	}
	if (error instanceof Error) {
		return { code: 'INTERNAL_ERROR', message: error.message };
	}
	return { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' };
}

export async function isBridgeReachable(): Promise<boolean> {
	try {
		const client = getBridgeClient();
		await client.get('/bridge/health', { timeout: 2000 });
		return true;
	} catch {
		return false;
	}
}

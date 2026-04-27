import { getBridgeClient, isBridgeReachable } from './bridge-client.js';
import { createLogger } from './logger.js';

const logger = createLogger('insights-bootstrap');

export interface BootstrapResult {
	wasRunning: boolean;
	started: boolean;
	message: string;
}

/**
 * Auto-bootstrap the Insights bridge at MCP session start.
 *
 * Checks if the bridge is running. If not, attempts to start it.
 * This is fire-and-forget: it does not block server startup.
 */
export async function autoBootstrapInsights(): Promise<BootstrapResult> {
	try {
		const reachable = await isBridgeReachable();
		if (reachable) {
			logger.debug('Insights bridge already running');
			return { wasRunning: true, started: false, message: 'Bridge already running' };
		}

		logger.info('Insights bridge not running — attempting auto-start');
		const bridge = getBridgeClient();

		// Try init first (idempotent)
		try {
			await bridge.post('/bridge/init', {}, { timeout: 3000 });
			logger.debug('Bridge init completed');
		} catch {
			// Init may fail if already initialized — that's fine
			logger.debug('Bridge init skipped (may already be initialized)');
		}

		// Start the bridge
		const { data } = await bridge.post('/bridge/start', {}, { timeout: 5000 });
		logger.info('Insights bridge auto-started', data);

		return {
			wasRunning: false,
			started: true,
			message: typeof data?.message === 'string' ? data.message : 'Bridge started',
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.warn('Insights auto-bootstrap failed', { error: message });

		return {
			wasRunning: false,
			started: false,
			message: `Auto-bootstrap failed: ${message}`,
		};
	}
}

/**
 * Attempt a final sync before the MCP session ends.
 *
 * This is best-effort: it fires and forgets, and never throws.
 */
export async function finalSyncBeforeShutdown(): Promise<void> {
	try {
		const reachable = await isBridgeReachable();
		if (!reachable) {
			logger.debug('Bridge not reachable for final sync');
			return;
		}

		logger.info('Triggering final Insights sync before shutdown');
		const bridge = getBridgeClient();
		await bridge.post('/insights/refresh', {}, { timeout: 8000 });
		logger.info('Final sync completed');
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.warn('Final sync failed', { error: message });
	}
}

/**
 * Register process exit handlers for graceful cleanup.
 *
 * In MCP stdio mode, the process may receive SIGTERM when the client closes.
 * We attempt a final sync and optionally stop the bridge if we started it.
 */
export function registerShutdownHandlers(): void {
	let isShuttingDown = false;

	async function shutdown(): Promise<void> {
		if (isShuttingDown) return;
		isShuttingDown = true;

		logger.info('MCP session ending — performing cleanup');
		await finalSyncBeforeShutdown();
		logger.info('Cleanup complete');
	}

	// SIGTERM is sent when the parent process (client) terminates us
	process.on('SIGTERM', () => {
		void shutdown().finally(() => process.exit(0));
	});

	// SIGINT is sent on Ctrl+C
	process.on('SIGINT', () => {
		void shutdown().finally(() => process.exit(0));
	});

	// beforeExit fires when the event loop is about to exit
	process.on('beforeExit', () => {
		void shutdown();
	});

	// uncaughtException — still try to sync before dying
	process.on('uncaughtException', (err) => {
		logger.error('Uncaught exception', err);
		void shutdown().finally(() => process.exit(1));
	});
}

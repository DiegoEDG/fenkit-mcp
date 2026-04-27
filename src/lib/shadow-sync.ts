import { getBridgeClient, isBridgeReachable } from './bridge-client.js';
import { createLogger } from './logger.js';

const logger = createLogger('shadow-sync');

export interface ShadowSyncOptions {
	projectId: string;
	providerItemId?: string;
	preferTargeted?: boolean;
	timeoutMs?: number;
}

export interface ShadowSyncResult {
	success: boolean;
	syncType: 'targeted' | 'full' | 'skipped';
	message: string;
}

/**
 * Trigger a shadow sync after an Engram mutation.
 *
 * This is fire-and-forget: it runs asynchronously and never throws.
 * Callers should `.catch()` and swallow errors so the primary Engram
 * action remains unaffected.
 */
export async function triggerShadowSync(options: ShadowSyncOptions): Promise<ShadowSyncResult> {
	const timeoutMs = options.timeoutMs ?? 5000;

	try {
		const bridgeAvailable = await isBridgeReachable();
		if (!bridgeAvailable) {
			logger.debug('Shadow sync skipped — bridge not reachable');
			return {
				success: false,
				syncType: 'skipped',
				message: 'Bridge not running — sync deferred to next cycle',
			};
		}

		const bridge = getBridgeClient();

		// Prefer targeted sync if we have a specific item ID
		if (options.preferTargeted && options.providerItemId) {
			logger.debug('Triggering targeted shadow sync', {
				projectId: options.projectId,
				providerItemId: options.providerItemId,
			});

			// Targeted sync: refresh the bridge (it will pick up the specific item)
			// In the future, the bridge could support a targeted refresh endpoint
			await bridge.post(
				'/insights/refresh',
				{ project: options.projectId },
				{ timeout: timeoutMs }
			);

			return {
				success: true,
				syncType: 'targeted',
				message: `Targeted sync triggered for ${options.providerItemId}`,
			};
		}

		// Full project refresh fallback
		logger.debug('Triggering full project shadow sync', {
			projectId: options.projectId,
		});

		await bridge.post(
			'/insights/refresh',
			{ project: options.projectId },
			{ timeout: timeoutMs }
		);

		return {
			success: true,
			syncType: 'full',
			message: `Full refresh triggered for project ${options.projectId}`,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.warn('Shadow sync failed', { error: message, projectId: options.projectId });

		return {
			success: false,
			syncType: 'skipped',
			message: `Sync failed: ${message}`,
		};
	}
}

/**
 * Fire-and-forget wrapper for triggerShadowSync.
 * Use this when you don't need to await the result.
 */
export function fireShadowSync(options: ShadowSyncOptions): void {
	triggerShadowSync(options).catch((err) => {
		logger.debug('Shadow sync error swallowed', { error: String(err) });
	});
}

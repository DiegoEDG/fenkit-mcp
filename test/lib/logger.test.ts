import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@lib/logger.js';

describe('stderr logger', () => {
	const originalLogLevel = process.env.FENKIT_LOG_LEVEL;

	beforeEach(() => {
		delete process.env.FENKIT_LOG_LEVEL;
	});

	afterEach(() => {
		if (originalLogLevel === undefined) {
			delete process.env.FENKIT_LOG_LEVEL;
		} else {
			process.env.FENKIT_LOG_LEVEL = originalLogLevel;
		}
		vi.restoreAllMocks();
	});

	it('writes log lines to stderr only', () => {
		const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
		const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

		const logger = createLogger('test');
		logger.info('hello from logger');

		expect(stderrSpy).toHaveBeenCalledTimes(1);
		expect(stdoutSpy).not.toHaveBeenCalled();
	});

	it('respects configured log level', () => {
		process.env.FENKIT_LOG_LEVEL = 'warn';
		const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

		const logger = createLogger('test');
		logger.info('should not be emitted');
		logger.warn('should be emitted');

		expect(stderrSpy).toHaveBeenCalledTimes(1);
		const firstCallArg = stderrSpy.mock.calls[0]?.[0];
		expect(String(firstCallArg)).toContain('[WARN]');
	});
});

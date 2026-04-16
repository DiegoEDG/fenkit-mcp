import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
	resolve: {
		alias: {
			'@lib': resolve(__dirname, './src/lib'),
			'@tools': resolve(__dirname, './src/tools'),
			'@lifecycle': resolve(__dirname, './src/lifecycle'),
			'@prompts': resolve(__dirname, './src/prompts'),
			'@resources': resolve(__dirname, './src/resources'),
			'@': resolve(__dirname, './src')
		}
	},
	test: {
		include: ['test/**/*.test.ts'],
		environment: 'node',
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json', 'html'],
			include: ['src/**/*.ts']
		}
	}
});
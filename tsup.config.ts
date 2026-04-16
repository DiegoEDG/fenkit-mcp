import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node18',
  clean: true,
  splitting: false,
  sourcemap: true,
  dts: false,
  esbuildOptions: (options) => {
    options.alias = {
      '@lib': './src/lib',
      '@tools': './src/tools',
      '@lifecycle': './src/lifecycle',
      '@prompts': './src/prompts',
      '@resources': './src/resources',
      '@': './src',
    };
  },
});

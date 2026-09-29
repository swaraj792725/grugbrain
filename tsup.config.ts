import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    clean: true,
    sourcemap: true,
    target: 'node18'
  },
  {
    // The CLI is one self-contained CommonJS file so the installer can copy it to ~/.grug/app.
    entry: ['src/cli.ts'],
    format: ['cjs'],
    sourcemap: true,
    target: 'node18',
    splitting: false
  }
]);

import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(readFileSync('./package.json', 'utf8'));
const define = { __GRUG_VERSION__: JSON.stringify(version) };

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    clean: true,
    sourcemap: true,
    target: 'node18',
    define
  },
  {
    // The CLI is one self-contained CommonJS file so the installer can copy it to ~/.grug/app.
    entry: ['src/cli.ts'],
    format: ['cjs'],
    sourcemap: true,
    target: 'node18',
    splitting: false,
    define
  }
]);

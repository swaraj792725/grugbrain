import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Forks, not threads: tests change HOME and must never reach the real user config.
    pool: 'forks',
    // plugin/*/tests run under `claude plugin test`, not vitest.
    include: ['tests/**/*.test.ts']
  }
});

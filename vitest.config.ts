import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['src/**/*.test.ts', 'spike/**/*.test.ts', 'tests/**/*.test.ts'], testTimeout: 20000 } });

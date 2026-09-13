import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['test/**/*.test.ts', 'ladder/**/*.test.ts'], testTimeout: 20000 },
});

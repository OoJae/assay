import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: { testTimeout: 60000, include: ['test/zz-pendingca-offchain.test.ts'], exclude: ['**/node_modules/**'] },
})

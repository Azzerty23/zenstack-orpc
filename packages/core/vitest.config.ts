import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    typecheck: { enabled: true, include: ['tests/**/*.test-d.ts'], tsconfig: './tsconfig.json' },
    testTimeout: 20_000,
  },
})

import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    openapi: 'src/openapi-entry.ts',
    node: 'src/node.ts',
    s3: 'src/s3.ts',
    'client/index': 'src/client/index.ts',
    'tanstack-query/index': 'src/tanstack-query/index.ts',
    'zenstack/plugin-orpc': 'src/zenstack/plugin-orpc.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  platform: 'neutral',
  deps: {
    neverBundle: [
      /^@orpc\//,
      /^@zenstackhq\/(?!client-helpers)/,
      /^@tanstack\//,
      'zod',
      'aws4fetch',
      /^node:/,
    ],
    // Bundled so the browser build doesn't get the whole ORM (see below).
    alwaysBundle: ['@zenstackhq/client-helpers'],
  },
  plugins: [
    {
      // `@zenstackhq/client-helpers` has a bare `import "@zenstackhq/orm"` (a type-only import
      // left by its build). It pulls the whole ORM, Zod and decimal.js into client bundles.
      name: 'strip-orm-side-effect-import',
      transform(code, id) {
        if (!id.includes('@zenstackhq/client-helpers')) return
        return code.replace(/^import\s+["']@zenstackhq\/orm["'];?\s*$/m, '')
      },
    },
  ],
})

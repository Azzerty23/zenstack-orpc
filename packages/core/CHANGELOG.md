# Changelog

## Unreleased

- **Optimistic updates follow `where` / `orderBy` / `take`.** Created records only appear in the
  lists they match, where they're sorted; updated records leaving a filtered list are removed.
  What can't be evaluated in memory is refreshed after the mutation instead. Without `orderBy`,
  new records are now added last (insertion order) instead of first.
- **Live infinite queries** refetch only the pages holding updated records. `$changes` batches
  carry the ids of the updated records the subscriber can read.
- **REST errors are documented.** The REST router declares `zenstackErrors` (exported): the
  OpenAPI document describes `400` / `403` / `404` / `422` responses, and error bodies are
  `defined: true`.
- **Files.** `upload` / `remove` delete the replaced file (`cleanup: true`) even when the user may
  write the field but not read it.
- **Transaction callbacks.** `client.db.$transaction((tx) => { ... })` records operations
  synchronously; their results are placeholders to pass to later operations or return (compiled
  to `txRef`s). Supported by `createZenStackClient`, `typedClient` and
  `createZenStackQueryUtils` (`mutate((tx) => ...)`, with invalidation of the recorded steps).
- **Single validation.** Procedure inputs are validated once: the ORM's own validation is
  skipped (`$setInputValidation(false)`), unless the client restricts inputs more than the
  router (`slicing` / `allowQueryTimeOmitOverride` not passed to `queryOptions`).
- **OpenAPI docs from ZModel.** `@@meta('description')` / `@meta('description')` and `///`
  comments (`docs`, now generated in `orpc.ts`) describe models, fields and operations.
  `@@meta('openapi:path')` and `@@meta('openapi:tags')` set a model's path and tags. Field-level
  policies are summarized next to model policies.
- **Infinite queries.** `findMany.infiniteOptions({ input: { ..., take } })` pages
  automatically (cursor on the id, or `pagination: 'offset'`), and `live: true` keeps the pages
  up to date from `$changes`.
- **Search.** `@fuzzy` / `@fullText` filters and relevance ordering are tested over RPC, REST
  and OpenAPI. Search results aren't patched optimistically (refreshed after the mutation).
- **Field-level policies and `post-update` rules** are tested, `@file` fields included.
- **ZenStack features.** `@@delegate` models are supported:
  - results of a base model are a discriminated union of its sub-models;
  - files, cascades and live topics follow the table-per-model layout.

  Views get read procedures only. `@computed` fields, `@omit` fields (query-level `omit` to bring
  them back), typed JSON, `Decimal` and `Bytes` are typed and tested. In REST, `Bytes` are base64.
- **Transactions.** `txRef(step, ...path)` references the result of an earlier
  `$transaction` step.
- **Errors.** `isZenStackError(error, reason?)` (`zenstack-orpc/client`) narrows
  `error.data`.
- **SSR.**
  - `zenstackHydration()` dehydrates and hydrates queries with `Date`, `BigInt`, `Decimal` and
    `Bytes` intact.
  - `connectLive(orpc, queryClient)` makes hydrated live queries live.
- **Files.**
  - `url` procedure (temporary download URLs).
  - `presign` / `confirm` procedures (direct uploads to the storage).
  - `createS3Storage` (`zenstack-orpc/s3`: S3, R2, MinIO...).
  - `FileStorage.stat` / `url` / `presignUpload`.
  - REST downloads with `ETag` / `304`, `Range` / `206`, `cacheControl` and `redirect`.
  - `String[] @file` fields (several files per field).
- **TanStack Query.**
  - Writes through a `@@delegate` base model (`asset.delete`) invalidate the sub-model queries
    (`video.findMany`).
  - Optimistic updates also apply across a `@@delegate` hierarchy: a `video.update` patches
    `asset.findMany`, a created `Image` is added to it, and an `asset.delete` patches `image`
    queries.
  - `@file` writes (`upload`, `remove`, `confirm`) invalidate the queries of their model.
- **REST paths.** Model paths no longer pluralize names that are already plural (`PostStats` →
  `/post-stats`).

## 0.1.0

First release, for oRPC `2.0.0-beta.42` and ZenStack `3.9`.

- `createZenStackRouter`: CRUD procedures for every model, validated with ZenStack's Zod schemas,
  with ORM errors mapped to `ORPCError`s, `zenstackMeta`, a sequential `$transaction` and
  configurable `limits` (`maxTake`, `defaultTake`, `maxDepth`, `maxTransactionSteps`).
- `createZenStackOpenAPIRouter` (`zenstack-orpc/openapi`): RESTful routes and a compact OpenAPI
  document reusing ZenStack's schema names (`ZenStackJsonSchemaConverter`).
- Live queries: `zenstackLive` ORM plugin, `$changes` stream with topics derived from queries
  (ids and foreign keys), authorized once per subscription, checked against read policies
  (`@@live(checkVisibility)`), database cascades included; `liveOptions` with `throttle`.
- `@file` fields (`zenstack-orpc/plugin-orpc` ZModel plugin): `upload` / `get` / `remove`
  procedures, `accept` / `maxSize` validation, `FileStorage` (memory, filesystem), opt-in cleanup
  with `@file(cleanup: true)` and the `zenstackFiles` ORM plugin (cascades included).
- Client: `createZenStackClient` and `createZenStackQueryUtils` with results inferred from
  `select` / `include` / `omit`, automatic invalidation, optimistic updates completed from
  `auth()` and the cache, and composable types (`WithZenStack`, `WithClient`, `WithQueryUtils`).

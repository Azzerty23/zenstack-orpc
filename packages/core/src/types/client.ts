import type {
  ClientContext,
  FriendlyClientOptions,
  ORPCError,
  PromiseWithError,
} from '@orpc/client'
import type { GetModels, SchemaDef } from '@zenstackhq/orm/schema'
import type { ZenStackErrorData } from '../errors'
import type { FileFieldsDef } from '../files/schema'
import type { ChangeBatch } from '../live/events'
import type { CrudOperation } from '../operations'
import type { TransactionOperation } from '../transaction'
import type {
  DefaultOperationResult,
  ModelOperation,
  OperationArgs,
  OperationResult,
  OptionalInputOperation,
} from './operations'
import type { ZenDefaultResult } from './result'
import type { ChangesInput } from './router'
import type { StrictQueryInput } from './strict'

/** Errors thrown by generated procedures. */
export type ZenStackClientError = ORPCError<string, ZenStackErrorData | unknown> | Error

type Options<TCtx extends ClientContext> = FriendlyClientOptions<TCtx>

type OptionsRest<TCtx extends ClientContext> = {} extends TCtx
  ? [options?: Options<TCtx>]
  : [options: Options<TCtx>]

/**
 * A procedure client whose result is inferred from its input (`select` / `include` / `omit`).
 */
export interface ZenStackOperationClient<
  S extends SchemaDef,
  M extends GetModels<S>,
  Op extends CrudOperation,
  TCtx extends ClientContext = object,
> {
  <T extends OperationArgs<S, M>[Op]>(
    input: OperationArgs<S, M>[Op] & StrictQueryInput<S, M, T, OperationArgs<S, M>[Op]>,
    ...rest: OptionsRest<TCtx>
  ): PromiseWithError<OperationResult<S, M, Op, T>, ZenStackClientError>
  (
    ...rest: Op extends OptionalInputOperation ? [input?: undefined, ...OptionsRest<TCtx>] : never
  ): PromiseWithError<DefaultOperationResult<S, M, Op>, ZenStackClientError>
}

/** Plain procedure client. */
export type ZenStackSimpleClient<TInput, TOutput, TCtx extends ClientContext = object> = (
  input: TInput,
  ...rest: OptionsRest<TCtx>
) => PromiseWithError<TOutput, ZenStackClientError>

type FileTarget<S extends SchemaDef, M extends GetModels<S>> = {
  where: OperationArgs<S, M>['findUnique']['where']
}

/** `String[] @file` fields: operations on one file take its key. */
type FileKey<Config> = Config extends { multiple: true } ? { key: string } : {}

/** Where to upload a file directly (see `presign`). */
export interface ZenStackPresignedUpload {
  key: string
  url: string
  method: 'PUT'
  headers: Record<string, string>
}

/** Procedures of a `@file` field. */
export interface ZenStackFileClient<
  S extends SchemaDef,
  M extends GetModels<S>,
  TCtx extends ClientContext = object,
  Config = {},
> {
  /** Uploads a file through the server (appended to `String[]` fields). */
  upload: ZenStackSimpleClient<
    FileTarget<S, M> & { file: File | Blob },
    ZenDefaultResult<S, M>,
    TCtx
  >
  /** Downloads the file. */
  get: ZenStackSimpleClient<FileTarget<S, M> & FileKey<Config>, File, TCtx>
  /** Clears the field (removes one file of `String[]` fields). */
  remove: ZenStackSimpleClient<FileTarget<S, M> & FileKey<Config>, ZenDefaultResult<S, M>, TCtx>
  /** A temporary URL downloading the file straight from the storage (`storage.url`). */
  url: ZenStackSimpleClient<
    FileTarget<S, M> & FileKey<Config> & { fileName?: string },
    { url: string; expiresAt: Date },
    TCtx
  >
  /**
   * A temporary URL to upload a file directly to the storage (`storage.presignUpload`): send it
   * with `fetch(url, { method, headers, body: file })`, then call `confirm({ where, key })`.
   */
  presign: ZenStackSimpleClient<
    FileTarget<S, M> & { name: string; type: string; size: number },
    ZenStackPresignedUpload,
    TCtx
  >
  /** Saves a file uploaded with `presign` (checked against `@file(accept, maxSize)`). */
  confirm: ZenStackSimpleClient<FileTarget<S, M> & { key: string }, ZenDefaultResult<S, M>, TCtx>
}

type FileFieldNames<Files, M> = Files extends FileFieldsDef
  ? M extends keyof Files
    ? Extract<keyof Files[M], string>
    : never
  : never

/** Typed client of one model. */
export type ZenStackModelClient<
  S extends SchemaDef,
  M extends GetModels<S>,
  TCtx extends ClientContext = object,
  Files = {},
> = { [Op in ModelOperation<S, M>]: ZenStackOperationClient<S, M, Op, TCtx> } & {
  [F in FileFieldNames<Files, M>]: ZenStackFileClient<S, M, TCtx, FileConfig<Files, M, F>>
}

type FileConfig<Files, M, F> = M extends keyof Files
  ? F extends keyof Files[M]
    ? Files[M][F]
    : {}
  : {}

/** A step of `$transaction`, typed per model and operation. */
export type ZenStackTransactionStep<S extends SchemaDef> = {
  [M in GetModels<S>]: {
    [Op in ModelOperation<S, M>]: Op extends OptionalInputOperation
      ? { model: M; op: Op; args?: OperationArgs<S, M>[Op] }
      : { model: M; op: Op; args: OperationArgs<S, M>[Op] }
  }[ModelOperation<S, M>]
}[GetModels<S>]

/**
 * An operation of the `$transaction` callback's `tx`: records the call and returns a placeholder
 * typed as its result, to pass to later operations or return.
 */
export interface ZenStackTransactionOperation<
  S extends SchemaDef,
  M extends GetModels<S>,
  Op extends CrudOperation,
> {
  <T extends OperationArgs<S, M>[Op]>(
    input: OperationArgs<S, M>[Op] & StrictQueryInput<S, M, T, OperationArgs<S, M>[Op]>,
  ): OperationResult<S, M, Op, T>
  (
    ...rest: Op extends OptionalInputOperation ? [input?: undefined] : never
  ): DefaultOperationResult<S, M, Op>
}

/** The `tx` of a `$transaction` callback. */
export type ZenStackTransactionClient<S extends SchemaDef> = {
  [M in GetModels<S> as Uncapitalize<M>]: {
    [Op in ModelOperation<S, M>]: ZenStackTransactionOperation<S, M, Op>
  }
}

/** Anything but a promise: a `$transaction` callback only records operations. */
type Synchronous =
  | { then?: never; valueOf(): unknown }
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  // biome-ignore lint/suspicious/noConfusingVoidType: callbacks returning nothing
  | void

/** A `$transaction` callback. Its return value is resolved once the transaction has run. */
export type ZenStackTransactionCallback<S extends SchemaDef, R = unknown> = (
  tx: ZenStackTransactionClient<S>,
) => R

/** Input of `$transaction`: steps, or a callback recording them. */
export type ZenStackTransactionInput<S extends SchemaDef> =
  | ZenStackTransactionStep<S>[]
  | ZenStackTransactionCallback<S>

/** The `$transaction` procedure client. */
export interface ZenStackTransactionClientFn<S extends SchemaDef, TCtx extends ClientContext> {
  /**
   * Runs the operations recorded by `callback` sequentially in one database transaction, and
   * resolves to what it returns (placeholders replaced with the results they stand for).
   */
  <R extends Synchronous>(
    callback: ZenStackTransactionCallback<S, R>,
    ...rest: OptionsRest<TCtx>
  ): PromiseWithError<R, ZenStackClientError>
  /** Runs `steps` sequentially in one database transaction, and resolves to their results. */
  (
    steps: ZenStackTransactionStep<S>[],
    ...rest: OptionsRest<TCtx>
  ): PromiseWithError<unknown[], ZenStackClientError>
}

/** Typed client of the router generated by `createZenStackRouter`. */
export type ZenStackRouterClient<
  S extends SchemaDef,
  TCtx extends ClientContext = object,
  Files = {},
> = {
  [M in GetModels<S> as Uncapitalize<M>]: ZenStackModelClient<S, M, TCtx, Files>
} & {
  $transaction: ZenStackTransactionClientFn<S, TCtx>
  $changes: (
    input: ChangesInput<S>,
    ...rest: OptionsRest<TCtx>
  ) => PromiseWithError<AsyncIteratorObject<ChangeBatch, void, void>, ZenStackClientError>
}

export type { TransactionOperation }

/** Replaces the property at a dotted `Path` of `T` with `V`. */
export type ApplyAtPath<T, Path extends string, V> = Path extends ''
  ? V
  : Path extends `${infer Head}.${infer Tail}`
    ? Omit<T, Head> & { [K in Head]: ApplyAtPath<Head extends keyof T ? T[Head] : {}, Tail, V> }
    : Omit<T, Path> & { [K in Path]: V }

/** Reads the property at a dotted `Path` of `T`. */
export type GetAtPath<T, Path extends string> = Path extends ''
  ? T
  : Path extends `${infer Head}.${infer Tail}`
    ? Head extends keyof T
      ? GetAtPath<T[Head], Tail>
      : never
    : Path extends keyof T
      ? T[Path]
      : never

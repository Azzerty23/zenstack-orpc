import type { ClientContext } from '@orpc/client'
import type {
  InfiniteOptionsIn,
  InfiniteOptionsOut,
  MutationOptionsIn,
  MutationOptionsOut,
  ProcedureUtils,
  QueryOptionsIn,
  QueryOptionsOut,
} from '@orpc/tanstack-query'
import type { InfiniteData, SkipToken } from '@tanstack/query-core'
import type { GetModels, SchemaDef } from '@zenstackhq/orm/schema'
import type { MutationOperation, QueryOperation } from '../operations'
import type {
  ZenStackClientError,
  ZenStackFileClient,
  ZenStackOperationClient,
  ZenStackTransactionClientFn,
  ZenStackTransactionInput,
} from '../types/client'
import type {
  DefaultOperationResult,
  ModelOperation,
  OperationArgs,
  OperationResult,
  OptionalInputOperation,
} from '../types/operations'
import type { WithOptimistic, ZenDefaultResult } from '../types/result'
import type { StrictQueryInput } from '../types/strict'
import type { PaginationMode, ZenStackPageParam } from './pagination'

type Args<
  S extends SchemaDef,
  M extends GetModels<S>,
  Op extends keyof OperationArgs<S, M>,
> = OperationArgs<S, M>[Op]

type Strict<
  S extends SchemaDef,
  M extends GetModels<S>,
  Op extends keyof OperationArgs<S, M>,
  T,
> = Args<S, M, Op> & StrictQueryInput<S, M, T, Args<S, M, Op>>

type Data<
  S extends SchemaDef,
  M extends GetModels<S>,
  Op extends QueryOperation,
  T,
> = WithOptimistic<OperationResult<S, M, Op, T>>

type DefaultData<
  S extends SchemaDef,
  M extends GetModels<S>,
  Op extends QueryOperation,
> = WithOptimistic<DefaultOperationResult<S, M, Op>>

/** Extra options of `liveOptions`. */
export interface LiveOptionsExtra {
  /**
   * Minimum delay between two refetches of this query (ms), overriding the `live.throttle`
   * option: changes during the delay are merged into one refetch at its end.
   */
  throttle?: number
}

/** Extra options of `infiniteOptions`. */
export interface InfiniteOptionsExtra {
  /**
   * Keep the loaded pages up to date from the `$changes` stream, like `liveOptions`: they're
   * refetched (all of them) when a model they read changes. `{ throttle }` sets a minimum delay
   * between two refetches (ms). Bound the refetch with TanStack's `maxPages`.
   */
  live?: boolean | LiveOptionsExtra
}

/** `findMany` args paged by `infiniteOptions`: `take` is the page size. */
type PagedArgs<S extends SchemaDef, M extends GetModels<S>, T> = Strict<S, M, 'findMany', T> & {
  take: number
}

/**
 * Pages `findMany` automatically: `take` is the page size, and the next page starts after the
 * last record loaded (`cursor` on its id), or after the records loaded with
 * `pagination: 'offset'` (the default for relevance ordering).
 */
type PagedInfiniteOptionsFn<
  S extends SchemaDef,
  M extends GetModels<S>,
  TCtx extends ClientContext,
> = <
  T extends Args<S, M, 'findMany'>,
  USelectData = InfiniteData<OperationResult<S, M, 'findMany', T>, ZenStackPageParam>,
  UInitialData = undefined,
>(
  options: Omit<
    InfiniteOptionsIn<
      TCtx,
      T,
      OperationResult<S, M, 'findMany', T>,
      ZenStackClientError,
      USelectData,
      ZenStackPageParam,
      UInitialData
    >,
    'input' | 'initialPageParam' | 'getNextPageParam'
  > & {
    input: PagedArgs<S, M, T>
    /** How the next page is loaded. @default 'cursor' ('offset' with relevance ordering) */
    pagination?: PaginationMode
  } & InfiniteOptionsExtra,
) => InfiniteOptionsOut<
  OperationResult<S, M, 'findMany', T>,
  ZenStackClientError,
  USelectData,
  ZenStackPageParam,
  UInitialData
>

/** oRPC's infinite options: pages computed by `input(pageParam)` and `getNextPageParam`. */
type CustomInfiniteOptionsFn<
  S extends SchemaDef,
  M extends GetModels<S>,
  Op extends QueryOperation,
  TCtx extends ClientContext,
> = <
  T extends Args<S, M, Op>,
  UPageParam,
  USelectData = InfiniteData<OperationResult<S, M, Op, T>, UPageParam>,
  UInitialData = undefined,
>(
  options: Omit<
    InfiniteOptionsIn<
      TCtx,
      T,
      OperationResult<S, M, Op, T>,
      ZenStackClientError,
      USelectData,
      UPageParam,
      UInitialData
    >,
    'input'
  > & {
    input: ((pageParam: UPageParam) => Strict<S, M, Op, T>) | SkipToken
  } & InfiniteOptionsExtra,
) => InfiniteOptionsOut<
  OperationResult<S, M, Op, T>,
  ZenStackClientError,
  USelectData,
  UPageParam,
  UInitialData
>

type InfiniteOptionsFn<
  S extends SchemaDef,
  M extends GetModels<S>,
  Op extends QueryOperation,
  TCtx extends ClientContext,
> = Op extends 'findMany'
  ? PagedInfiniteOptionsFn<S, M, TCtx> & CustomInfiniteOptionsFn<S, M, Op, TCtx>
  : CustomInfiniteOptionsFn<S, M, Op, TCtx>

type QueryOptionsFn<
  S extends SchemaDef,
  M extends GetModels<S>,
  Op extends QueryOperation,
  TCtx extends ClientContext,
  Extra = {},
> = {
  <T extends Args<S, M, Op>, USelectData = Data<S, M, Op, T>, UInitialData = undefined>(
    options: Omit<
      QueryOptionsIn<TCtx, T, Data<S, M, Op, T>, ZenStackClientError, USelectData, UInitialData>,
      'input'
    > & { input: Strict<S, M, Op, T> | SkipToken } & Extra,
  ): QueryOptionsOut<Data<S, M, Op, T>, ZenStackClientError, USelectData, UInitialData>
  <USelectData = DefaultData<S, M, Op>, UInitialData = undefined>(
    ...rest: Op extends OptionalInputOperation
      ? [
          options?: QueryOptionsIn<
            TCtx,
            undefined,
            DefaultData<S, M, Op>,
            ZenStackClientError,
            USelectData,
            UInitialData
          > &
            Extra,
        ]
      : never
  ): QueryOptionsOut<DefaultData<S, M, Op>, ZenStackClientError, USelectData, UInitialData>
}

/** TanStack Query utils of a ZenStack read operation, with results inferred from the input. */
export interface ZenStackQueryUtils<
  S extends SchemaDef,
  M extends GetModels<S>,
  Op extends QueryOperation,
  TCtx extends ClientContext = object,
> extends Omit<
    ProcedureUtils<
      TCtx,
      Args<S, M, Op> | undefined,
      DefaultOperationResult<S, M, Op>,
      ZenStackClientError
    >,
    'call' | 'queryOptions' | 'liveOptions' | 'infiniteOptions' | 'streamedOptions' | 'streamedKey'
  > {
  call: ZenStackOperationClient<S, M, Op, TCtx>
  queryOptions: QueryOptionsFn<S, M, Op, TCtx>
  /**
   * Query options kept up to date from the `$changes` stream: the query refetches (through the
   * regular policy-checked procedure) whenever a model it reads changes.
   */
  liveOptions: QueryOptionsFn<S, M, Op, TCtx, LiveOptionsExtra>
  /**
   * Infinite query options. `findMany` pages automatically from its `take`; `live: true` keeps
   * the pages up to date from the `$changes` stream.
   */
  infiniteOptions: InfiniteOptionsFn<S, M, Op, TCtx>
}

/** TanStack Query utils of a ZenStack write operation. */
export interface ZenStackMutationUtils<
  S extends SchemaDef,
  M extends GetModels<S>,
  Op extends MutationOperation,
  TCtx extends ClientContext = object,
> extends Omit<
    ProcedureUtils<TCtx, Args<S, M, Op>, DefaultOperationResult<S, M, Op>, ZenStackClientError>,
    'call' | 'mutationOptions'
  > {
  call: ZenStackOperationClient<S, M, Op, TCtx>
  /**
   * Mutation options. Pass the expected arguments as type parameter to type the result of
   * `select` / `include`: `mutationOptions<{ include: { author: true } }>()`.
   */
  mutationOptions<T extends Args<S, M, Op> = Args<S, M, Op>, UMutationContext = unknown>(
    ...rest: object extends TCtx
      ? [
          options?: MutationOptionsIn<
            TCtx,
            T,
            OperationResult<S, M, Op, T>,
            ZenStackClientError,
            UMutationContext
          >,
        ]
      : [
          options: MutationOptionsIn<
            TCtx,
            T,
            OperationResult<S, M, Op, T>,
            ZenStackClientError,
            UMutationContext
          >,
        ]
  ): MutationOptionsOut<T, OperationResult<S, M, Op, T>, ZenStackClientError, UMutationContext>
}

type SimpleUtils<TCtx extends ClientContext, TInput, TOutput> = Omit<
  ProcedureUtils<TCtx, TInput, TOutput, ZenStackClientError>,
  'streamedOptions' | 'streamedKey'
>

type FileUtils<S extends SchemaDef, M extends GetModels<S>, TCtx extends ClientContext, Config> = {
  [K in keyof ZenStackFileClient<S, M, TCtx, Config>]: ZenStackFileClient<
    S,
    M,
    TCtx,
    Config
  >[K] extends (input: infer I, ...rest: any[]) => Promise<infer O>
    ? SimpleUtils<TCtx, I, O>
    : never
}

type FileFieldNames<Files, M> = M extends keyof Files ? Extract<keyof Files[M], string> : never

/** TanStack Query utils of a model. */
export type ZenStackModelUtils<
  S extends SchemaDef,
  M extends GetModels<S>,
  TCtx extends ClientContext = object,
  Files = {},
> = { [Op in QueryOperation]: ZenStackQueryUtils<S, M, Op, TCtx> } & {
  [Op in MutationOperation & ModelOperation<S, M>]: ZenStackMutationUtils<S, M, Op, TCtx>
} & {
  [F in FileFieldNames<Files, M>]: FileUtils<
    S,
    M,
    TCtx,
    M extends keyof Files ? (F extends keyof Files[M] ? Files[M][F] : {}) : {}
  >
} & {
  key: ProcedureUtils<TCtx, unknown, unknown, ZenStackClientError>['key']
}

/** TanStack Query utils of a ZenStack router. */
export type ZenStackRouterUtils<
  S extends SchemaDef,
  TCtx extends ClientContext = object,
  Files = {},
> = {
  [M in GetModels<S> as Uncapitalize<M>]: ZenStackModelUtils<S, M, TCtx, Files>
} & {
  /** `mutate(steps)` or `mutate((tx) => { ... })` (see the client's `$transaction`). */
  $transaction: Omit<SimpleUtils<TCtx, ZenStackTransactionInput<S>, unknown>, 'call'> & {
    call: ZenStackTransactionClientFn<S, TCtx>
  }
  key: ProcedureUtils<TCtx, unknown, unknown, ZenStackClientError>['key']
}

export type { ZenDefaultResult }

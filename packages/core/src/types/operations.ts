import type {
  AggregateArgs,
  AggregateResult,
  CountArgs,
  CountResult,
  CreateArgs,
  CreateManyAndReturnArgs,
  CreateManyArgs,
  DeleteArgs,
  DeleteManyArgs,
  ExistsArgs,
  FindFirstArgs,
  FindManyArgs,
  FindUniqueArgs,
  GroupByArgs,
  GroupByResult,
  UpdateArgs,
  UpdateManyAndReturnArgs,
  UpdateManyArgs,
  UpsertArgs,
} from '@zenstackhq/orm'
import type { GetModels, SchemaDef } from '@zenstackhq/orm/schema'
import type { CrudOperation, QueryOperation } from '../operations'
import type { ZenDefaultResult, ZenResult } from './result'

/** Whether a model is a database view (`view` in ZModel). */
export type IsView<S extends SchemaDef, M extends GetModels<S>> = S['models'][M] extends {
  isView: true
}
  ? true
  : false

/** Operations exposed for a model: views are read-only. */
export type ModelOperation<S extends SchemaDef, M extends GetModels<S>> =
  IsView<S, M> extends true ? QueryOperation : CrudOperation

/** ZenStack argument type of each operation. */
export type OperationArgs<S extends SchemaDef, M extends GetModels<S>> = {
  findMany: FindManyArgs<S, M>
  findUnique: FindUniqueArgs<S, M>
  findFirst: FindFirstArgs<S, M>
  exists: ExistsArgs<S, M>
  count: CountArgs<S, M>
  aggregate: AggregateArgs<S, M>
  groupBy: GroupByArgs<S, M>
  create: CreateArgs<S, M>
  createMany: CreateManyArgs<S, M>
  createManyAndReturn: CreateManyAndReturnArgs<S, M>
  update: UpdateArgs<S, M>
  updateMany: UpdateManyArgs<S, M>
  updateManyAndReturn: UpdateManyAndReturnArgs<S, M>
  upsert: UpsertArgs<S, M>
  delete: DeleteArgs<S, M>
  deleteMany: DeleteManyArgs<S, M>
}

/** Operations whose input may be omitted. */
export type OptionalInputOperation = 'findMany' | 'findFirst' | 'exists' | 'count' | 'deleteMany'

/** Operations whose result shape depends on `select` / `include` / `omit`. */
export type DynamicResultOperation =
  | 'findMany'
  | 'findUnique'
  | 'findFirst'
  | 'create'
  | 'createManyAndReturn'
  | 'update'
  | 'updateManyAndReturn'
  | 'upsert'
  | 'delete'

/** Input type of an operation, as accepted by the generated procedure. */
export type OperationInput<
  S extends SchemaDef,
  M extends GetModels<S>,
  Op extends CrudOperation,
> = Op extends OptionalInputOperation
  ? OperationArgs<S, M>[Op] | undefined
  : OperationArgs<S, M>[Op]

/** Result type of an operation for the given arguments. */
export type OperationResult<
  S extends SchemaDef,
  M extends GetModels<S>,
  Op extends CrudOperation,
  Args,
> = Op extends 'findMany' | 'createManyAndReturn' | 'updateManyAndReturn'
  ? ZenResult<S, M, Args>[]
  : Op extends 'findUnique' | 'findFirst'
    ? ZenResult<S, M, Args> | null
    : Op extends 'create' | 'update' | 'upsert' | 'delete'
      ? ZenResult<S, M, Args>
      : Op extends 'exists'
        ? boolean
        : Op extends 'count'
          ? CountResult<S, M, Args>
          : Op extends 'aggregate'
            ? AggregateResult<S, M, Args>
            : Op extends 'groupBy'
              ? Args extends GroupByArgs<S, M>
                ? GroupByResult<S, M, Args>
                : Record<string, unknown>[]
              : { count: number }

/** Result type of an operation called without `select` / `include` / `omit`. */
export type DefaultOperationResult<
  S extends SchemaDef,
  M extends GetModels<S>,
  Op extends CrudOperation,
> = Op extends 'findMany' | 'createManyAndReturn' | 'updateManyAndReturn'
  ? ZenDefaultResult<S, M>[]
  : Op extends 'findUnique' | 'findFirst'
    ? ZenDefaultResult<S, M> | null
    : Op extends 'create' | 'update' | 'upsert' | 'delete'
      ? ZenDefaultResult<S, M>
      : Op extends 'exists'
        ? boolean
        : Op extends 'count'
          ? number
          : Op extends 'aggregate'
            ? Record<string, unknown>
            : Op extends 'groupBy'
              ? Record<string, unknown>[]
              : { count: number }

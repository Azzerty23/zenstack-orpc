import type { MapModelFieldType, NonParamComputedNonRelationFields } from '@zenstackhq/orm'
import type {
  FieldIsArray,
  GetModelDiscriminator,
  GetModels,
  GetSubModels,
  IsDelegateModel,
  ModelFieldIsOptional,
  NonRelationFields,
  RelationFields,
  RelationFieldType,
  SchemaDef,
} from '@zenstackhq/orm/schema'

// Result types are adapted from zenstack-trpc (https://github.com/olup/zenstack-trpc).
//
// They intentionally don't use ZenStack's `ModelResult` / `SimplifiedPlainResult`: mapping
// `NonRelationFields` directly keeps type instantiation shallow on large schemas
// (zenstackhq/zenstack#2569), and splitting scalar / relation parts keeps tsgo happy.

/**
 * Whether a field is left out of results: `omit: { field: true }` in the query, else `@omit` in
 * the schema (`omit: { field: false }` brings it back).
 */
type IsOmitted<S extends SchemaDef, M extends GetModels<S>, Key, O> = Key extends keyof O
  ? O[Key] extends boolean
    ? O[Key]
    : SchemaOmit<S['models'][M]['fields'], Key>
  : SchemaOmit<S['models'][M]['fields'], Key>

type SchemaOmit<Fields, Key> = Key extends keyof Fields
  ? Fields[Key] extends { omit: true }
    ? true
    : false
  : false

/** Scalar fields of a model's own rows. */
type FlatResult<S extends SchemaDef, M extends GetModels<S>, O> = {
  [Key in NonParamComputedNonRelationFields<S, M> as IsOmitted<S, M, Key, O> extends true
    ? never
    : Key]: MapModelFieldType<S, M, Key>
}

/**
 * A `@@delegate` model's rows: one of its concrete sub-models, told apart by the discriminator
 * (`asset.kind === 'Video'` narrows to `Video`'s fields).
 */
type DelegateResult<
  S extends SchemaDef,
  M extends GetModels<S>,
  Sub extends GetModels<S>,
  O,
  Depth extends readonly 0[] = [],
> =
  Sub extends GetModels<S>
    ? (Depth['length'] extends 5
        ? FlatResult<S, Sub, O>
        : IsDelegateModel<S, Sub> extends true
          ? DelegateResult<S, Sub, GetSubModels<S, Sub>, O, [...Depth, 0]>
          : FlatResult<S, Sub, O>) & {
        [K in GetModelDiscriminator<S, M>]: DiscriminatorValue<S, Sub>
      }
    : never

/** Discriminator value of a sub-model's rows: its `delegateMap` value, else its name. */
type DiscriminatorValue<S extends SchemaDef, Sub extends GetModels<S>> = S['models'][Sub] extends {
  delegateMap: infer V extends string
}
  ? V
  : Sub

/**
 * Scalar fields of a model (the result of a query without select/include), minus omitted ones
 * (`O`: the query's `omit`).
 */
export type ZenDefaultResult<
  S extends SchemaDef,
  M extends GetModels<S>,
  O = undefined,
> = string extends M
  ? { [Key in NonRelationFields<S, M>]: MapModelFieldType<S, M, Key> }
  : IsDelegateModel<S, M> extends true
    ? DelegateResult<S, M, GetSubModels<S, M>, O>
    : FlatResult<S, M, O>

type Falsy = false | null | undefined

/** Flattens intersections for readable (and comparable) types. */
export type Simplify<T> = { [K in keyof T]: T[K] } & {}

type WrapRelationType<
  S extends SchemaDef,
  M extends GetModels<S>,
  Key extends RelationFields<S, M>,
  Args,
> =
  FieldIsArray<S, M, Key> extends true
    ? ZenResult<S, RelationFieldType<S, M, Key>, Args>[]
    : ModelFieldIsOptional<S, M, Key> extends true
      ? ZenResult<S, RelationFieldType<S, M, Key>, Args> | null
      : ZenResult<S, RelationFieldType<S, M, Key>, Args>

type CountResultPart<CountArg> = CountArg extends true
  ? { [K: string]: number }
  : CountArg extends { select: infer Sel extends object }
    ? { [K in keyof Sel as Sel[K] extends Falsy ? never : K]: number }
    : never

type CountPart<Arg extends object> = '_count' extends keyof Arg
  ? Arg['_count'] extends Falsy
    ? {}
    : { _count: CountResultPart<Arg['_count']> }
  : {}

type SelectScalarPart<S extends SchemaDef, M extends GetModels<S>, Sel extends object> = {
  [Key in keyof Sel & NonRelationFields<S, M> as Sel[Key] extends Falsy
    ? never
    : Key]: MapModelFieldType<S, M, Key>
}

type RelationPart<S extends SchemaDef, M extends GetModels<S>, Sel extends object> = {
  [Key in keyof Sel & RelationFields<S, M> as Sel[Key] extends Falsy
    ? never
    : Key]: WrapRelationType<S, M, Key, Sel[Key]>
}

type ScalarResult<S extends SchemaDef, M extends GetModels<S>, Args> = Args extends {
  omit: infer O extends object
}
  ? ZenDefaultResult<S, M, O>
  : ZenDefaultResult<S, M>

/**
 * Result of a query on model `M` with arguments `Args`, honoring `select`, `include`,
 * `omit` and `_count`.
 */
export type ZenResult<S extends SchemaDef, M extends GetModels<S>, Args> = Args extends {
  select: infer Sel extends object
}
  ? Simplify<SelectScalarPart<S, M, Sel> & RelationPart<S, M, Sel> & CountPart<Sel>>
  : Args extends { include: infer Inc extends object }
    ? Simplify<ScalarResult<S, M, Args> & RelationPart<S, M, Inc> & CountPart<Inc>>
    : Simplify<ScalarResult<S, M, Args>>

/** Marks data written by an optimistic update (see `@zenstackhq/client-helpers`). */
export type WithOptimistic<T> = T extends readonly (infer U)[]
  ? Simplify<U & { $optimistic?: boolean }>[]
  : T extends Date | Blob
    ? T
    : T extends object
      ? Simplify<T & { $optimistic?: boolean }>
      : T

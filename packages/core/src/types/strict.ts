import type { IncludeInput, OmitInput, SelectInput } from '@zenstackhq/orm'
import type {
  GetModels,
  RelationFields,
  RelationFieldType,
  SchemaDef,
} from '@zenstackhq/orm/schema'
import type { OperationArgs } from './operations'

// Adapted from zenstack-trpc: a generic `T extends Args` keeps output inference but accepts
// extra nested keys. These helpers reject keys outside the select/include/omit shapes.

type NoExtraKeys<T, Shape> = T extends object
  ? T & { [K in Exclude<keyof T, keyof Shape>]: never }
  : T

type PreserveNullish<T, Strict> = Strict | Extract<T, null | undefined>

type StrictRelationInput<S extends SchemaDef, M extends GetModels<S>, T, Shape> = T extends object
  ? NoExtraKeys<
      {
        [K in keyof T]: K extends RelationFields<S, M>
          ? T[K] extends boolean
            ? T[K]
            : StrictQueryInput<
                S,
                RelationFieldType<S, M, K>,
                T[K],
                OperationArgs<S, RelationFieldType<S, M, K>>['findMany']
              >
          : T[K]
      },
      Shape
    >
  : T

/** Rejects unknown keys in `select`, `include` and `omit` (recursively through relations). */
export type StrictQueryInput<
  S extends SchemaDef,
  M extends GetModels<S>,
  T,
  Shape,
> = T extends object
  ? NoExtraKeys<
      {
        [K in keyof T]: K extends 'select'
          ? PreserveNullish<T[K], StrictRelationInput<S, M, NonNullable<T[K]>, SelectInput<S, M>>>
          : K extends 'include'
            ? PreserveNullish<
                T[K],
                StrictRelationInput<S, M, NonNullable<T[K]>, IncludeInput<S, M>>
              >
            : K extends 'omit'
              ? PreserveNullish<T[K], NoExtraKeys<NonNullable<T[K]>, OmitInput<S, M>>>
              : T[K]
      },
      Shape
    >
  : T

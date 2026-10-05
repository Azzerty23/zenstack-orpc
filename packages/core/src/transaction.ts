import { ORPCError, ValidationError } from '@orpc/server'
import type { SchemaDef } from '@zenstackhq/orm/schema'
import { z } from 'zod'
import { withORPCErrors } from './errors'
import { applyLimits, checkTransactionSteps, type QueryLimits } from './limits'
import { zenstackMeta } from './meta'
import {
  CRUD_OPERATIONS,
  type CrudOperation,
  isQueryOperation,
  lowerCaseFirst,
  skipRevalidation,
} from './operations'
import { isView } from './schema-utils'
import { collectRefs, resolveRef, resolveRefs } from './transaction-ref'

/** One step of a sequential transaction. */
export interface TransactionOperation {
  model: string
  op: CrudOperation
  args?: unknown
}

/**
 * Builds the `$transaction` procedure: runs ZenStack operations sequentially in one database
 * transaction (like `@zenstackhq/server`'s `/$transaction/sequential`). Args can reference the
 * results of earlier steps with `txRef(step, ...path)` (`{ $ref: [step, ...path] }`).
 */
export function createTransactionProcedure(
  modelNames: string[],
  base: any,
  getDb: (context: any) => any,
  schemaFor: (model: string, op: CrudOperation) => z.ZodType,
  options: {
    schema?: SchemaDef
    limits?: QueryLimits
    queryOptions?: Record<string, unknown>
  } = {},
) {
  const limits = options.limits ?? {}
  const step = z.object({
    model: z.enum(modelNames as [string, ...string[]]),
    op: z.enum(CRUD_OPERATIONS),
    args: z.unknown().optional(),
  })

  return base
    .meta(zenstackMeta({ operation: '$transaction' }))
    .input(z.array(step).min(1))
    .handler(async ({ context, input }: { context: any; input: TransactionOperation[] }) => {
      checkTransactionSteps(input.length, limits)
      const prepare = (operation: TransactionOperation, args: unknown, index: number) => {
        const result = schemaFor(operation.model, operation.op).safeParse(args)
        if (!result.success) {
          throw new ORPCError('BAD_REQUEST', {
            message: `Invalid args for ${operation.model}.${operation.op} (operation #${index})`,
            cause: new ValidationError({
              message: result.error.message,
              issues: result.error.issues as any,
              invalidData: args,
            }),
          })
        }
        return options.schema
          ? applyLimits(options.schema, operation.model, operation.op, result.data, limits)
          : result.data
      }

      // Validate every step up front, so nothing runs if one of them is invalid. Steps
      // referencing earlier results (`txRef`) are validated once resolved, in the transaction.
      const steps = input.map((operation, index) => {
        if (
          options.schema &&
          isView(options.schema, operation.model) &&
          !isQueryOperation(operation.op)
        ) {
          throw new ORPCError('BAD_REQUEST', {
            message: `${operation.model} is a view: ${operation.op} isn't allowed (operation #${index})`,
          })
        }
        const refs = collectRefs(operation.args)
        for (const { $ref } of refs) {
          if ($ref[0] < 0 || $ref[0] >= index) {
            throw new ORPCError('BAD_REQUEST', {
              message: `Operation #${index} can only reference earlier operations (got $ref ${JSON.stringify($ref)})`,
            })
          }
        }
        return {
          ...operation,
          refs: refs.length > 0,
          args: refs.length > 0 ? operation.args : prepare(operation, operation.args, index),
        }
      })

      return withORPCErrors(() =>
        // Every step is validated by `prepare`.
        skipRevalidation(getDb(context), options.queryOptions).$transaction(async (tx: any) => {
          const results: unknown[] = []
          for (const [index, step] of steps.entries()) {
            const args = step.refs
              ? prepare(
                  step,
                  resolveRefs(step.args, (ref) => {
                    const value = resolveRef(ref, results)
                    if (value === undefined) {
                      throw new ORPCError('BAD_REQUEST', {
                        message: `Operation #${index}: $ref ${JSON.stringify(ref.$ref)} doesn't resolve`,
                      })
                    }
                    return value
                  }),
                  index,
                )
              : step.args
            results.push(await tx[lowerCaseFirst(step.model)][step.op](args))
          }
          return results
        }),
      )
    })
}

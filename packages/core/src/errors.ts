import { ORPCError } from '@orpc/server'
import { ORMError, ORMErrorReason } from '@zenstackhq/orm'
import { z } from 'zod'

/** Data attached to errors translated from ZenStack `ORMError`s. */
export interface ZenStackErrorData {
  reason: `${ORMErrorReason}`
  model?: string
  rejectedByPolicyReason?: string
  dbErrorCode?: unknown
}

const CODE_BY_REASON: Record<string, string> = {
  [ORMErrorReason.NOT_FOUND]: 'NOT_FOUND',
  [ORMErrorReason.INVALID_INPUT]: 'UNPROCESSABLE_CONTENT',
  [ORMErrorReason.REJECTED_BY_POLICY]: 'FORBIDDEN',
  [ORMErrorReason.DB_QUERY_ERROR]: 'BAD_REQUEST',
}

function errorData(reason: `${ORMErrorReason}`, extra: z.ZodRawShape = {}) {
  return z.object({
    reason: z.literal(reason),
    model: z.string().optional().describe('Model of the failed operation'),
    ...extra,
  })
}

/**
 * Errors of ZenStack operations, as an oRPC error map (`.errors(zenstackErrors)`): the REST router
 * declares them so the OpenAPI document describes its error responses. Errors are
 * still thrown by `toORPCError`; declaring them only marks them as `defined`.
 */
export const zenstackErrors = {
  BAD_REQUEST: {
    message: 'Invalid input, or query rejected by the database (`db-query-error`)',
    data: errorData(ORMErrorReason.DB_QUERY_ERROR, {
      dbErrorCode: z.unknown().optional().describe('Database error code (e.g. `23505`)'),
    }),
  },
  FORBIDDEN: {
    message: 'Rejected by access policies (`rejected-by-policy`)',
    data: errorData(ORMErrorReason.REJECTED_BY_POLICY, {
      rejectedByPolicyReason: z.string().optional(),
    }),
  },
  NOT_FOUND: {
    message: 'Record not found, or not readable (`not-found`)',
    data: errorData(ORMErrorReason.NOT_FOUND),
  },
  UNPROCESSABLE_CONTENT: {
    message: 'Input rejected by ZenStack (`invalid-input`)',
    data: errorData(ORMErrorReason.INVALID_INPUT),
  },
} as const

/**
 * Translates an error thrown by the ZenStack ORM into an `ORPCError`.
 *
 * The mapping follows `@zenstackhq/server`: not-found -> NOT_FOUND, invalid-input ->
 * UNPROCESSABLE_CONTENT, rejected-by-policy -> FORBIDDEN, db-query-error -> BAD_REQUEST,
 * anything else -> INTERNAL_SERVER_ERROR. `ORPCError`s and unknown errors are returned as is.
 */
export function toORPCError(error: unknown): unknown {
  if (!(error instanceof ORMError)) {
    return error
  }

  const code = CODE_BY_REASON[error.reason] ?? 'INTERNAL_SERVER_ERROR'
  const data: ZenStackErrorData = { reason: error.reason }
  if (error.model) data.model = error.model
  if (error.rejectedByPolicyReason) data.rejectedByPolicyReason = error.rejectedByPolicyReason
  if (error.dbErrorCode !== undefined) data.dbErrorCode = error.dbErrorCode

  return new ORPCError(code, {
    message: code === 'INTERNAL_SERVER_ERROR' ? undefined : error.message,
    data,
    cause: error,
  })
}

/** Runs `fn` and rethrows ZenStack errors as `ORPCError`s. */
export async function withORPCErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    throw toORPCError(error)
  }
}

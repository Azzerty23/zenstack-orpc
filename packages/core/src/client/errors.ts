import { ORPCError } from '@orpc/client'
import type { ZenStackErrorData } from '../errors'

export type { ZenStackErrorData }

/** Why the ORM rejected an operation (`error.data.reason`). */
export type ZenStackErrorReason = ZenStackErrorData['reason']

/** An error translated from a ZenStack `ORMError` (see `toORPCError`). */
export type ZenStackError<R extends ZenStackErrorReason = ZenStackErrorReason> = ORPCError<
  string,
  ZenStackErrorData & { reason: R }
>

/**
 * Whether an error comes from the ZenStack ORM, optionally with a given reason. Narrows
 * `error.data` to {@link ZenStackErrorData}.
 *
 * @example
 * ```ts
 * if (isZenStackError(error, 'rejected-by-policy')) toast("You can't edit this post")
 * if (isZenStackError(error, 'db-query-error') && error.data.dbErrorCode === '23505') ...
 * ```
 */
export function isZenStackError<R extends ZenStackErrorReason = ZenStackErrorReason>(
  error: unknown,
  reason?: R,
): error is ZenStackError<R> {
  if (!(error instanceof ORPCError)) return false
  const data = error.data as Partial<ZenStackErrorData> | undefined
  if (typeof data?.reason !== 'string') return false
  return reason === undefined || data.reason === reason
}

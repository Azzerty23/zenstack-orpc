import { ORPCError } from '@orpc/client'
import { isZenStackError } from 'zenstack-orpc/client'

/** A readable message for a failed call. */
export function errorMessage(error: unknown): string {
  // Rejected by the ORM: access policies, missing records, `@@validate` rules...
  if (isZenStackError(error, 'rejected-by-policy')) return "You aren't allowed to do that."
  if (isZenStackError(error, 'not-found')) return 'It no longer exists.'
  // Rejected by the procedure's input schema (`@length`, `@email`...): the first issue.
  if (error instanceof ORPCError && error.code === 'BAD_REQUEST') {
    const issues = (error.data as { issues?: Issue[] } | undefined)?.issues
    const issue = issues?.[0] && firstIssue(issues[0])
    if (issue) return `${issue.path.at(-1)?.toString() ?? 'input'}: ${issue.message}`
  }
  return error instanceof Error ? error.message : String(error)
}

interface Issue {
  message: string
  path?: PropertyKey[]
  /** Issues of each member of a union (`invalid_union`). */
  errors?: Issue[][]
}

/** The innermost issue: ZenStack's input schemas are unions (e.g. checked / unchecked data). */
function firstIssue(issue: Issue, parent: PropertyKey[] = []): Issue & { path: PropertyKey[] } {
  const path = [...parent, ...(issue.path ?? [])]
  const nested = issue.errors?.[0]?.[0]
  return nested ? firstIssue(nested, path) : { ...issue, path }
}

/** The message of the first error, if any. */
export function firstError(...errors: unknown[]): string | undefined {
  const error = errors.find(Boolean)
  return error ? errorMessage(error) : undefined
}

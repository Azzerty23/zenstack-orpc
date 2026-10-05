import { createAuthClient } from 'better-auth/react'

export const authClient = createAuthClient({ basePath: '/api/auth' })

type SessionUser = NonNullable<ReturnType<typeof authClient.useSession>['data']>['user']

let currentUser: SessionUser | null = null

/** The signed-in user, as seen by `auth()` in ZModel (used by optimistic updates). */
export const getCurrentUser = () => currentUser

/** Keeps {@link getCurrentUser} in sync with the better-auth session. */
export function setCurrentUser(user: SessionUser | null | undefined) {
  currentUser = user ?? null
}

import { zenstackAdapter } from '@zenstackhq/better-auth'
import { betterAuth } from 'better-auth'
import { bearer, openAPI } from 'better-auth/plugins'
import { db } from './db'

export const auth = betterAuth({
  basePath: '/api/auth',
  secret: process.env.BETTER_AUTH_SECRET ?? 'dev-secret-change-me-dev-secret-change-me',
  trustedOrigins: [process.env.WEB_ORIGIN ?? 'http://localhost:5173'],
  database: zenstackAdapter(db, { provider: 'sqlite' }),
  emailAndPassword: { enabled: true, autoSignIn: true },
  plugins: [
    // REST clients authenticate with `Authorization: Bearer <token>`, the `token` returned by
    // `POST /api/auth/sign-in/email` (browsers keep using the session cookie).
    bearer(),
    // Documents the auth endpoints, merged into the REST reference (`/api/reference`).
    openAPI({ disableDefaultReference: true }),
  ],
})

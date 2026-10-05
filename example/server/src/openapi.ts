import { type OpenAPIDocument, OpenAPIGenerator } from '@orpc/openapi'
import { ZenStackJsonSchemaConverter } from 'zenstack-orpc/openapi'
import { auth } from './auth'
import { restRouter } from './router'

/** better-auth endpoints documented in the REST reference, under `/api/auth`. */
const AUTH_PATHS = ['/sign-up/email', '/sign-in/email', '/get-session', '/sign-out']
/** Signing up or in needs no credentials. */
const PUBLIC_AUTH_PATHS = ['/sign-up/email', '/sign-in/email']

type Document = OpenAPIDocument<'3.2.0'>

/**
 * better-auth's documentation of `AUTH_PATHS`, tagged `Auth`. Its schemas are prefixed with
 * `Auth` (`AuthUser`...), as `User` is already the ZenStack model's.
 */
async function authDocument() {
  const document = await auth.api.generateOpenAPISchema()
  const rename = (value: unknown) =>
    JSON.parse(
      JSON.stringify(value).replaceAll('"#/components/schemas/', '"#/components/schemas/Auth'),
    )
  const paths = Object.fromEntries(
    AUTH_PATHS.map((path) => {
      const operations = Object.fromEntries(
        Object.entries(rename(document.paths[path]) as Record<string, Record<string, unknown>>).map(
          ([method, operation]) => [
            method,
            {
              ...operation,
              tags: ['Auth'],
              security: PUBLIC_AUTH_PATHS.includes(path) ? [] : undefined,
            },
          ],
        ),
      )
      return [`/auth${path}`, operations]
    }),
  )
  const schemas = Object.fromEntries(
    Object.entries(rename(document.components.schemas)).map(([name, schema]) => [
      `Auth${name}`,
      schema,
    ]),
  )
  return {
    paths: paths as NonNullable<Document['paths']>,
    schemas: schemas as NonNullable<NonNullable<Document['components']>['schemas']>,
  }
}

/**
 * The REST API's OpenAPI document: the ZenStack routes (reusing ZenStack's schema names,
 * `PostWhereInput`...) and the auth endpoints. Every route requires a session, sent as
 * `Authorization: Bearer <token>` (the `token` returned by `POST /api/auth/sign-in/email`) or as
 * better-auth's session cookie (same-origin browsers).
 */
export async function generateSpec(): Promise<Document> {
  const [document, authDoc] = await Promise.all([
    new OpenAPIGenerator({
      converters: [new ZenStackJsonSchemaConverter(restRouter)],
    }).generate(restRouter, {
      base: {
        info: {
          title: 'zenstack-orpc example',
          version: '1.0.0',
          description:
            'Sign in with `POST /auth/sign-in/email`, then send the returned `token` as a bearer token.',
        },
        servers: [{ url: '/api' }],
        components: {
          securitySchemes: {
            bearerAuth: {
              type: 'http',
              scheme: 'bearer',
              description: 'Session token returned by `POST /auth/sign-in/email`',
            },
            cookieAuth: { type: 'apiKey', in: 'cookie', name: 'better-auth.session_token' },
          },
        },
        security: [{ bearerAuth: [] }, { cookieAuth: [] }],
        tags: [{ name: 'Auth', description: 'Sessions (better-auth)' }],
      },
    }),
    authDocument(),
  ])
  return {
    ...document,
    paths: { ...authDoc.paths, ...document.paths },
    components: {
      ...document.components,
      schemas: { ...document.components?.schemas, ...authDoc.schemas },
    },
  }
}

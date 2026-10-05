import { QueryClientProvider } from '@tanstack/react-query'
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { authClient, setCurrentUser } from './auth'
import { queryClient } from './orpc'
import { Chat } from './routes/chat'
import { Login } from './routes/login'
import { Posts } from './routes/posts'
import { Todos } from './routes/todos'
import './styles.css'

function Layout() {
  const session = authClient.useSession()
  setCurrentUser(session.data?.user)
  if (session.isPending) return <p className="container">Loading…</p>
  if (!session.data)
    return (
      <main className="container">
        <Login />
      </main>
    )
  return (
    <main className="container">
      <header>
        <nav>
          <Link to="/">Todos</Link>
          <Link to="/posts">Posts</Link>
          <Link to="/chat">Chat</Link>
          <a href="/api/reference" target="_blank" rel="noreferrer">
            REST API
          </a>
        </nav>
        <span>
          {session.data.user.name}{' '}
          <button
            type="button"
            className="link"
            onClick={() => authClient.signOut().then(() => queryClient.clear())}
          >
            Sign out
          </button>
        </span>
      </header>
      <Outlet />
    </main>
  )
}

const rootRoute = createRootRoute({ component: Layout })
const routeTree = rootRoute.addChildren([
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: function TodosPage() {
      const session = authClient.useSession()
      const userId = session.data?.user.id
      return userId ? <Todos userId={userId} /> : null
    },
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/posts',
    component: function PostsPage() {
      const session = authClient.useSession()
      return <Posts userId={session.data?.user.id ?? ''} />
    },
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/chat',
    component: function ChatPage() {
      const session = authClient.useSession()
      return <Chat userId={session.data?.user.id ?? ''} />
    },
  }),
])
const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)

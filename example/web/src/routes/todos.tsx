import { useMutation, useQuery } from '@tanstack/react-query'
import { firstError } from '../errors'
import { orpc } from '../orpc'

/**
 * Live + optimistic todo list:
 * - `liveOptions` refetches when one of the user's todos changes, wherever the write comes from
 *   (other tab, other server, a script...). Filtering on `ownerId` (even though policies already
 *   do it) scopes the subscription to this user's todos: other users' writes aren't sent here;
 * - mutations patch the cache before the server answers, and roll back on error;
 * - "Archive done" runs two operations on two models in one database transaction, the second one
 *   using the id of the article created by the first one.
 */
export function Todos({ userId }: { userId: string }) {
  const todos = useQuery(
    orpc.db.todo.findMany.liveOptions({
      // Archived todos belong to a post.
      input: { where: { ownerId: userId, postId: null }, orderBy: { id: 'asc' } },
    }),
  )

  const remaining = useQuery(
    orpc.db.todo.count.liveOptions({
      input: { where: { ownerId: userId, postId: null, done: false } },
    }),
  )
  const create = useMutation(orpc.db.todo.create.mutationOptions())
  const update = useMutation(orpc.db.todo.update.mutationOptions())
  const remove = useMutation(orpc.db.todo.delete.mutationOptions())
  // Sequential and atomic: if a step fails (validation, policy...), nothing is written.
  // Queries reading `Post` or `Todo` are invalidated afterwards.
  const archive = useMutation(orpc.db.$transaction.mutationOptions())

  const done = todos.data?.filter((todo) => todo.done && !todo.$optimistic) ?? []
  // The callback records the operations (it's synchronous: results aren't known yet), which run
  // on the server in one request.
  const archiveDone = () =>
    archive.mutate((tx) => {
      // A private draft article listing the completed todos (see the Posts page). `Post` is a
      // polymorphic base: posts are created through a sub-model...
      const article = tx.article.create({
        data: {
          title: `Completed ${done.length} todo${done.length > 1 ? 's' : ''}`,
          content: done.map((todo) => `- ${todo.title}`).join('\n'),
          published: false,
        },
      })
      // ...to which the todos are moved: `article.id` stands for the id of the article above.
      tx.todo.updateMany({
        where: { id: { in: done.map((todo) => todo.id) } },
        data: { postId: article.id },
      })
    })

  return (
    <section className="card">
      <h2>Todos {remaining.data !== undefined && <small>({remaining.data} left)</small>}</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          const input = event.currentTarget.elements.namedItem('title') as HTMLInputElement
          if (!input.value.trim()) return
          create.mutate({ data: { title: input.value.trim() } })
          input.value = ''
        }}
      >
        <input name="title" placeholder="What needs to be done?" autoComplete="off" />
        <button type="submit">Add</button>
      </form>
      {todos.isPending && <p>Loading…</p>}
      <ul>
        {todos.data?.map((todo) => (
          <li key={todo.id} className={todo.$optimistic ? 'optimistic' : undefined}>
            <label>
              <input
                type="checkbox"
                checked={todo.done}
                onChange={() =>
                  update.mutate({ where: { id: todo.id }, data: { done: !todo.done } })
                }
              />
              <span className={todo.done ? 'done' : undefined}>{todo.title}</span>
            </label>
            <button
              type="button"
              className="link danger"
              disabled={todo.$optimistic}
              onClick={() => remove.mutate({ where: { id: todo.id } })}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
      {done.length > 0 && (
        <button type="button" disabled={archive.isPending} onClick={archiveDone}>
          Archive done ({done.length})
        </button>
      )}
      {firstError(create.error, update.error, remove.error, archive.error) && (
        <p className="error">
          {firstError(create.error, update.error, remove.error, archive.error)}
        </p>
      )}
    </section>
  )
}

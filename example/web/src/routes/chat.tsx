import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { firstError } from '../errors'
import { orpc } from '../orpc'

/**
 * Chat rooms. The room list is a live query; messages are a **live infinite query**:
 * - pages of 10 messages, newest first, loaded by cursor ("Load older");
 * - filtering on `roomId` scopes the subscription to this room: messages posted in other rooms
 *   don't refetch it;
 * - a new or deleted message refetches the loaded pages; an edited message only refetches the
 *   page holding it (see the "updated at" of each page).
 *
 * Open the room in two windows (or as two users) to see it.
 */
export function Chat({ userId }: { userId: string }) {
  const rooms = useQuery(
    orpc.db.room.findMany.liveOptions({ input: { orderBy: { createdAt: 'asc' } } }),
  )
  const [selected, setSelected] = useState<string>()
  const roomId = selected ?? rooms.data?.[0]?.id
  const createRoom = useMutation(orpc.db.room.create.mutationOptions())

  return (
    <section className="card chat">
      <h2>Chat</h2>
      <nav className="rooms">
        {rooms.data?.map((room) => (
          <button
            key={room.id}
            type="button"
            className={room.id === roomId ? 'active' : undefined}
            disabled={room.$optimistic}
            onClick={() => setSelected(room.id)}
          >
            #{room.name}
          </button>
        ))}
      </nav>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          const input = event.currentTarget.elements.namedItem('name') as HTMLInputElement
          const name = input.value.trim()
          if (!name) return
          createRoom.mutate({ data: { name } }, { onSuccess: (room) => setSelected(room.id) })
          input.value = ''
        }}
      >
        <input name="name" placeholder="New room" autoComplete="off" />
        <button type="submit">Create</button>
      </form>
      {firstError(createRoom.error) && <p className="error">{firstError(createRoom.error)}</p>}
      {rooms.isSuccess && !roomId && <p>Create a room to start chatting.</p>}
      {roomId && <Room key={roomId} roomId={roomId} userId={userId} />}
    </section>
  )
}

const PAGE_SIZE = 10

function Room({ roomId, userId }: { roomId: string; userId: string }) {
  const messages = useInfiniteQuery(
    orpc.db.message.findMany.infiniteOptions({
      input: {
        where: { roomId },
        // `id` breaks ties between messages sent in the same millisecond.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: { author: { select: { name: true } } },
        take: PAGE_SIZE,
      },
      live: true,
    }),
  )
  const send = useMutation(orpc.db.message.create.mutationOptions())
  const edit = useMutation(orpc.db.message.update.mutationOptions())
  const remove = useMutation(orpc.db.message.delete.mutationOptions())
  const updatedAt = usePageUpdates(messages.data?.pages)

  // Stay at the bottom when a new message arrives (not when older pages load).
  const list = useRef<HTMLDivElement>(null)
  const newest = messages.data?.pages[0]?.[0]?.id
  useEffect(() => {
    if (newest) list.current?.scrollTo({ top: list.current.scrollHeight })
  }, [newest])

  // Oldest page first, oldest message first.
  const pages = [...(messages.data?.pages ?? [])].map((page, index) => ({ page, index })).reverse()

  return (
    <>
      <div className="messages" ref={list}>
        {messages.hasNextPage && (
          <button
            type="button"
            className="link"
            disabled={messages.isFetchingNextPage}
            onClick={() => messages.fetchNextPage()}
          >
            {messages.isFetchingNextPage ? 'Loading…' : 'Load older messages'}
          </button>
        )}
        {messages.isPending && <p>Loading…</p>}
        {pages.map(({ page, index }) => (
          <div key={index} className="page">
            <p className="page-label">
              page {index + 1} · updated at {updatedAt.get(page)}
            </p>
            <ul>
              {[...page].reverse().map((message) => (
                <li key={message.id} className="message">
                  <span>
                    <strong>{message.author.name}</strong>{' '}
                    <span className="text">{message.text}</span>
                    {message.editedAt && <small> (edited)</small>}
                  </span>
                  {message.authorId === userId && (
                    <span className="actions">
                      <button
                        type="button"
                        className="link"
                        onClick={() => {
                          const text = window.prompt('Edit message', message.text)?.trim()
                          if (!text || text === message.text) return
                          edit.mutate({
                            where: { id: message.id },
                            data: { text, editedAt: new Date() },
                          })
                        }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="link danger"
                        onClick={() => remove.mutate({ where: { id: message.id } })}
                      >
                        Delete
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          const input = event.currentTarget.elements.namedItem('text') as HTMLInputElement
          const text = input.value.trim()
          if (!text) return
          send.mutate({ data: { text, roomId } }, { onSuccess: () => input.focus() })
          input.value = ''
        }}
      >
        <input name="text" placeholder="Message" autoComplete="off" disabled={send.isPending} />
        <button type="submit" disabled={send.isPending}>
          Send
        </button>
      </form>
      {firstError(send.error, edit.error, remove.error) && (
        <p className="error">{firstError(send.error, edit.error, remove.error)}</p>
      )}
    </>
  )
}

/**
 * When each page last changed. Pages keep their identity when they don't change (TanStack's
 * structural sharing, and partial refetches only swap the pages they refetched).
 */
function usePageUpdates(pages: readonly object[] | undefined) {
  const times = useRef(new WeakMap<object, string>())
  for (const page of pages ?? []) {
    if (!times.current.has(page)) times.current.set(page, new Date().toLocaleTimeString())
  }
  return times.current
}

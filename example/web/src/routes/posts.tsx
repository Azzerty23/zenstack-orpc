import { ORPCError } from '@orpc/client'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { firstError } from '../errors'
import { client, orpc } from '../orpc'

/**
 * Served by the REST router with an ETag: the browser revalidates it (`304 Not Modified`), or is
 * redirected to a signed URL of the bucket. The stored key changes with each upload, so it's
 * added to the URL to load the new image.
 */
function PhotoImage({ id, imageKey }: { id: string; imageKey: string }) {
  return <img src={`/api/photos/${id}/image?v=${encodeURIComponent(imageKey)}`} alt="" />
}

/**
 * Uploads an image straight to the bucket when the storage supports it (`presign`, then
 * `confirm` saves the key in the photo), through the server otherwise (`upload`).
 */
async function uploadImage(id: string, file: File, confirm: typeof client.db.photo.image.confirm) {
  const where = { id }
  try {
    const target = await client.db.photo.image.presign({
      where,
      name: file.name,
      type: file.type,
      size: file.size,
    })
    const response = await fetch(target.url, {
      method: target.method,
      headers: target.headers,
      body: file,
    })
    if (!response.ok) throw new Error(`Upload failed (${response.status})`)
    return await confirm({ where, key: target.key })
  } catch (error) {
    // The local disk storage has no direct uploads.
    if (!(error instanceof ORPCError && error.code === 'NOT_IMPLEMENTED')) throw error
    return client.db.photo.image.upload({ where, file })
  }
}

/**
 * Posts with their author (inferred from `include`). `Post` is polymorphic (`@@delegate(kind)`):
 * one query returns articles and photos, typed as a union narrowed by `kind`. They're created
 * through their sub-model (`article.create`, `photo.create`), which updates the `post.findMany`
 * query optimistically and live.
 */
export function Posts({ userId }: { userId: string }) {
  const [kind, setKind] = useState<'Article' | 'Photo'>('Article')
  const posts = useQuery(
    orpc.db.post.findMany.liveOptions({
      input: {
        orderBy: { createdAt: 'desc' },
        include: { author: { select: { name: true } }, _count: { select: { todos: true } } },
      },
    }),
  )
  const createArticle = useMutation(orpc.db.article.create.mutationOptions())
  const createPhoto = useMutation(orpc.db.photo.create.mutationOptions())
  const confirm = useMutation(orpc.db.photo.image.confirm.mutationOptions())
  const upload = useMutation({
    mutationFn: ({ id, file }: { id: string; file: File }) =>
      uploadImage(id, file, (input) => confirm.mutateAsync(input)),
  })
  const remove = useMutation(orpc.db.post.delete.mutationOptions())
  const error = firstError(createArticle.error, createPhoto.error, upload.error, remove.error)
  const pending = createArticle.isPending || createPhoto.isPending || upload.isPending

  return (
    <section className="card">
      <h2>Posts</h2>
      <form
        className="post-form"
        onSubmit={async (event) => {
          event.preventDefault()
          const form = event.currentTarget
          const data = new FormData(form)
          const title = String(data.get('title'))
          if (kind === 'Article') {
            const content = String(data.get('content') ?? '')
            await createArticle.mutateAsync({ data: { title, content: content || null } })
          } else {
            const caption = String(data.get('caption') ?? '')
            const photo = await createPhoto.mutateAsync({
              data: { title, caption: caption || null },
            })
            const file = data.get('image')
            if (file instanceof File && file.size > 0) {
              await upload.mutateAsync({ id: photo.id, file })
            }
          }
          form.reset()
        }}
      >
        <select
          name="kind"
          aria-label="Kind"
          value={kind}
          onChange={(event) => setKind(event.target.value as typeof kind)}
        >
          <option value="Article">Article</option>
          <option value="Photo">Photo</option>
        </select>
        <input name="title" placeholder="Title" required />
        {kind === 'Article' ? (
          <textarea name="content" placeholder="Content" rows={3} />
        ) : (
          <>
            <input name="caption" placeholder="Caption" />
            <input name="image" type="file" accept="image/*" />
          </>
        )}
        <button type="submit" disabled={pending}>
          Publish
        </button>
      </form>
      {error && <p className="error">{error}</p>}
      <ul className="posts">
        {posts.data?.map((post) => (
          <li key={post.id} className={post.$optimistic ? 'optimistic' : undefined}>
            <div className="post-header">
              <span>
                <strong>{post.title}</strong>{' '}
                <small>
                  {post.kind.toLowerCase()} by {post.author.name}
                </small>
                {post.authorId === userId && <em> (you)</em>}
                {!post.published && <em> · draft</em>}
                {post._count.todos > 0 && <small> · {post._count.todos} archived todos</small>}
              </span>
              {/* Only the author may delete (`@@allow('all', auth() == author)`). */}
              {post.authorId === userId && (
                <button
                  type="button"
                  className="link danger"
                  disabled={post.$optimistic}
                  // Deletes the `Post` row and, by cascade, the sub-model's. A photo's stored image
                  // is deleted by `zenstackFiles` on the server.
                  onClick={() => remove.mutate({ where: { id: post.id } })}
                >
                  Delete
                </button>
              )}
            </div>
            {/* Narrowed by the discriminator: `content` only exists on articles, `image` on photos. */}
            {post.kind === 'Article' && post.content && <pre>{post.content}</pre>}
            {post.kind === 'Photo' && (
              <>
                {post.image && <PhotoImage id={post.id} imageKey={post.image} />}
                {post.caption && <p className="caption">{post.caption}</p>}
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

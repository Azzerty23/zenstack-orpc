// In-memory S3-compatible server to try direct uploads locally (`bun run fake-s3`, PORT=9000 by
// default). Path-style, with CORS. Only checks that requests are signed, not the signatures: use
// MinIO or a real bucket to test credentials.

import { createServer } from 'node:http'

const port = Number(process.env.PORT ?? 9000)
const objects = new Map<string, { body: Buffer; type: string }>()
const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, PUT, HEAD, DELETE',
  'access-control-allow-headers': 'content-type',
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end()
  const signed = url.searchParams.has('X-Amz-Signature') || !!req.headers.authorization
  console.log(req.method, url.pathname, signed ? '' : '(unsigned: rejected)')
  if (!signed) return res.writeHead(403, cors).end()

  const key = url.pathname
  if (req.method === 'PUT') {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk)
    objects.set(key, { body: Buffer.concat(chunks), type: req.headers['content-type'] ?? '' })
    return res.writeHead(200, cors).end()
  }
  if (req.method === 'DELETE') {
    objects.delete(key)
    return res.writeHead(204, cors).end()
  }
  const object = objects.get(key)
  if (!object) return res.writeHead(404, cors).end()
  res.writeHead(200, { ...cors, 'content-type': object.type, 'content-length': object.body.length })
  return res.end(req.method === 'HEAD' ? undefined : object.body)
}).listen(port, () => console.log(`Fake S3: http://localhost:${port}/bucket`))

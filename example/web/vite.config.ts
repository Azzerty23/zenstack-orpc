import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const server = process.env.SERVER_URL ?? 'http://localhost:3000'

export default defineConfig({
  plugins: [react()],
  // Same-origin requests: better-auth cookies and oRPC calls go through the Vite proxy.
  server: { proxy: { '/rpc': server, '/api': server } },
})

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Must match the server's port (see .env / server/env.ts); overridable so a
// dev server can run alongside another instance (e.g. the extension's).
const API_PORT = Number(process.env.MERMAID_API_PORT ?? 8790)

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': `http://127.0.0.1:${API_PORT}`,
    },
  },
})

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const host = process.env.NOVEL_READER_HOST || '127.0.0.1'
const port = Number(process.env.NOVEL_READER_PORT || process.env.PORT || 5173)

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host,
    port,
    strictPort: true,
  },
  preview: {
    host,
    port,
    strictPort: true,
  },
})

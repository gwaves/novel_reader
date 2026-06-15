import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const host = process.env.NOVEL_READER_HOST || '0.0.0.0'
const port = Number(process.env.NOVEL_READER_PORT || process.env.PORT || 5173)
const apiPort = Number(process.env.NOVEL_READER_API_PORT || 5174)

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'spa-fallback-for-mobile',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url?.startsWith('/mobile')) {
            req.url = '/'
          }
          next()
        })
      },
    },
  ],
  server: {
    host,
    port,
    strictPort: true,
    proxy: {
      '/api': `http://127.0.0.1:${apiPort}`,
    },
  },
  preview: {
    host,
    port,
    strictPort: true,
  },
})

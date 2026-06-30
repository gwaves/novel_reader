import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import packageJson from './package.json' with { type: 'json' }

export default defineConfig({
  base: './',
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(packageJson.version),
  },
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5373,
    strictPort: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 5373,
    strictPort: true,
  },
})

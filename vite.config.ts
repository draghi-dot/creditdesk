import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.VITE_PORT ?? 5173),
    strictPort: true,
    // The assessment engine (server/index.ts) serves the API and live run streams.
    proxy: { '/api': { target: 'http://127.0.0.1:' + (process.env.ENGINE_PORT ?? 8787), changeOrigin: false } },
  },
})

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// host: true binds all interfaces (IPv4 + IPv6). With the default ('localhost')
// Vite listened on ::1 only, so http://127.0.0.1:5173 was refused. It also lets
// people open the dev server from a phone on the same wifi.
// The proxy targets 127.0.0.1 explicitly so 'localhost' can never resolve to ::1
// when the API happens to listen on IPv4 only.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:3001' },
  },
  preview: {
    host: true,
    port: 4173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:3001' },
  },
})

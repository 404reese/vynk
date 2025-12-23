import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: ['unliquidating-hinderingly-clay.ngrok-free.app'],
    port: 3000
  },
})

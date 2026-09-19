import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Tauri expects a fixed port and no auto-open; the webview is the only client.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: { target: 'safari16', outDir: 'dist', emptyOutDir: true },
})

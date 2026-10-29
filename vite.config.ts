import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Tauri expects a fixed port and no auto-open browser.
// `smoke.html` / `capture.html` live at the project root: the dev server serves
// them at `/smoke.html` and `/capture.html`, while `vite build` only bundles
// `index.html`, so the automation pages never reach `dist/` or the installer.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: '127.0.0.1',
    watch: {
      // Rust sources are rebuilt by cargo, not by vite.
      ignored: ['**/src-tauri/**'],
    },
  },
  build: {
    target: 'chrome110',
    sourcemap: false,
    rollupOptions: {
      input: {
        main: 'index.html',
      },
    },
  },
});

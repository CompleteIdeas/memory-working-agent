import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Builds the SPA to ../dist-ui, which `mwa serve` serves. base:'./' keeps asset paths
// relative so the same bundle works when served locally, from Tauri, or hosted.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  build: { outDir: '../dist-ui', emptyOutDir: true },
  server: { port: 5179, proxy: { '/api': 'http://localhost:7788' } },
});

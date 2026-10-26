import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
import { mwaFixtures } from './src/v2/dev/vite-plugin';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// Builds the SPA to ../dist-ui, which `mwa serve` serves. base:'./' keeps asset paths
// relative so the same bundle works when served locally, from Tauri, or hosted.
// v2 (slice W1): MWA_FIXTURES=1 makes `vite` / `vite preview` answer /api/v1 from the prototype's example day
// (web/src/v2/README.md); the client reports its version as X-MWA-Client: web/<package.json version>.
export default defineConfig({
  plugins: [react(), tailwindcss(), mwaFixtures({ enabled: process.env.MWA_FIXTURES === '1', scenario: process.env.MWA_FIXTURE_SCENARIO })],
  base: './',
  define: { __MWA_WEB_VERSION__: JSON.stringify(pkg.version) },
  build: { outDir: '../dist-ui', emptyOutDir: true },
  server: { port: 5179, proxy: { '/api': 'http://localhost:7788' } },
});

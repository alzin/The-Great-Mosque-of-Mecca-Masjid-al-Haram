import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs so the production build can be opened from any path,
  // including a plain file server or a subdirectory.
  base: './',
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      // Only the application is built for production. character-preview.html
      // is a development harness and is deliberately left out.
      input: 'index.html',
      output: {
        // Three.js is by far the largest dependency and never changes between
        // builds; splitting it out keeps the application chunk small and
        // cacheable. Rolldown (Vite 8) requires the function form.
        manualChunks(id: string) {
          if (id.includes('node_modules/three')) return 'three';
          return undefined;
        },
      },
    },
  },
  server: { host: '127.0.0.1', port: 5173 },
  preview: { host: '127.0.0.1', port: 4173 },
});

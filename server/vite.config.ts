import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * Server bundle (Node 24, ESM): the process entry, the session worker and the set-password tool. Everything from
 * src/ and server/src/ is bundled in; only node: built-ins stay external, so the build needs no node_modules.
 */
export default defineConfig({
  root,
  logLevel: 'warn',
  build: {
    ssr: true,
    outDir: 'server/dist',
    emptyOutDir: true,
    target: 'node24',
    minify: false,
    sourcemap: true,
    rollupOptions: {
      input: {
        main: 'server/src/main.ts',
        worker: 'server/src/worker/entry.ts',
        'set-password': 'server/src/setPassword.ts',
      },
      output: { format: 'es', entryFileNames: '[name].js', chunkFileNames: 'chunks/[name]-[hash].js' },
    },
  },
  ssr: { noExternal: true, target: 'node' },
});

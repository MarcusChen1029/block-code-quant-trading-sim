import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/** Vite's usual budget for every chunk (kB, minified). */
const CHUNK_BUDGET_KB = 500;
/**
 * The block editor chunk is Blockly itself (~760 kB minified, ~210 kB gzip) and cannot be split further without
 * dropping Blockly features. It is loaded lazily (main.ts: import('./ui/blockEditor')) after the chart and top bar
 * render, so it gets its own, documented budget. Every other chunk keeps the 500 kB one.
 */
const LAZY_CHUNK_BUDGET_KB: Record<string, number> = { blockEditor: 900 };

/** Per-chunk size budgets (Vite's own chunkSizeWarningLimit is one global number). */
function chunkBudgets(): Plugin {
  return {
    name: 'quant-sim-chunk-budgets',
    apply: 'build',
    generateBundle(_options, bundle) {
      for (const out of Object.values(bundle)) {
        if (out.type !== 'chunk') continue;
        const kb = new TextEncoder().encode(out.code).length / 1000;
        const budget = LAZY_CHUNK_BUDGET_KB[out.name] ?? CHUNK_BUDGET_KB;
        if (kb > budget) this.warn(`chunk ${out.fileName} is ${kb.toFixed(2)} kB, over its ${budget} kB budget`);
      }
    },
  };
}

export default defineConfig({
  plugins: [chunkBudgets()],
  // Vite's global warning is raised to the largest per-chunk budget; chunkBudgets() enforces the real ones.
  build: { chunkSizeWarningLimit: Math.max(CHUNK_BUDGET_KB, ...Object.values(LAZY_CHUNK_BUDGET_KB)) },
  worker: { format: 'es' },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});

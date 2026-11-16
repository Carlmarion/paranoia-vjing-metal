import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Show day serves the build on the same address as `npm run dev`: presets, calibration and drawn shapes live in
  // the browser per address (localStorage, IndexedDB), so a different port would start empty.
  preview: { port: 5173, strictPort: true },
  build: {
    rollupOptions: {
      input: { display: 'index.html', control: 'control.html' },
    },
  },
  test: { include: ['tests/**/*.test.ts'] },
});

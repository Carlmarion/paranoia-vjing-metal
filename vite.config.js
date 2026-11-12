import { defineConfig } from 'vitest/config';
export default defineConfig({
    build: {
        rollupOptions: {
            input: { display: 'index.html', control: 'control.html' },
        },
    },
    test: { include: ['tests/**/*.test.ts'] },
});

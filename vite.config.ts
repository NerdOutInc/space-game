import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/space-game/' : '/',
  server: { port: 5173, strictPort: true },
}));

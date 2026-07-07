import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  base: command === 'build' ? process.env.VITE_BASE_PATH ?? '/' : '/',
  server: { port: 5173, strictPort: true },
}));

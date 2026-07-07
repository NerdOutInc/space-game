import { defineConfig } from 'vite';

export default defineConfig(({ command }) => {
  const basePath = process.env.VITE_BASE_PATH ?? '/';

  return {
    base: command === 'build' ? basePath : '/',
    server: { port: 5173, strictPort: true },
  };
});

import { defineConfig } from 'vite';

export default defineConfig({
  base: '/hoax-mini-games/',
  server: {
    port: 5173,
    host: true, // 같은 네트워크 기기에서도 접속 가능
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});

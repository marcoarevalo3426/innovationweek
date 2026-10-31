import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { apiProxy } from './dev/api-proxy.js';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const port = Number(env.PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid backend API port.');
  const host = env.HOST === '::1' ? '[::1]' : ['127.0.0.1', 'localhost'].includes(env.HOST) ? env.HOST : '127.0.0.1';
  const proxy = apiProxy(`http://${host}:${port}`);
  return {
    plugins: [react()],
    server: { host: '127.0.0.1', port: 5173, strictPort: true, watch: { usePolling: true }, proxy },
    preview: { proxy },
  };
});

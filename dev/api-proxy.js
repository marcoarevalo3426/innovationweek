export function apiProxy(target) {
  return {
    '/api': {
      target,
      configure(proxy) {
        proxy.on('error', (_error, _request, response) => {
          if (!response || typeof response.writeHead !== 'function' || response.headersSent || response.writableEnded) return;
          response.writeHead(503, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          response.end(JSON.stringify({ error: 'The app service is unavailable. Please try again shortly.' }));
        });
      },
    },
  };
}

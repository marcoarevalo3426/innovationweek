export function isLocalAuthEnabled(env = process.env) {
  return (!env.NODE_ENV || env.NODE_ENV === 'development')
    && env.LOCAL_AUTH_BYPASS !== 'false'
    && ['127.0.0.1', 'localhost', '::1'].includes(env.HOST || '127.0.0.1');
}

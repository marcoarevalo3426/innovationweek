export function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

// Login is open to the entire exact domain; ADMIN_EMAILS only assigns administrator roles.
export function isNepEmail(value) {
  const email = normalizeEmail(value);
  return email.length <= 254
    && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@nepgroup\.com$/.test(email)
    && !email.startsWith('.')
    && !email.includes('..')
    && !email.includes('.@');
}

// Text is stored as data and rendered through React's escaping, never as HTML.
export function textValue(value, {label = 'Text', max = 4000, optional = false, multiline = true} = {}) {
  if (value === undefined && optional) return '';
  if (typeof value !== 'string') throw Object.assign(new Error(`${label} must be text.`), {status:400});
  const text = value.trim();
  if ((!optional && !text) || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) || (!multiline && /[\r\n\t]/u.test(value))) {
    throw Object.assign(new Error(`${label} must contain ${optional ? 'at most' : '1 to'} ${max} characters of readable text.`), {status:400});
  }
  return text;
}

export function fullName(value) {
  const name = textValue(value, {label:'Your full name',max:120,multiline:false});
  if (!/^[\p{L}\p{M} .’'\-]+$/u.test(name) || !/\p{L}/u.test(name)) throw Object.assign(new Error('Enter your full name using letters, spaces, apostrophes, periods or hyphens.'), {status:400});
  return name;
}

export function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && [null,Object.prototype].includes(Object.getPrototypeOf(value));
}

export function hasUnsafeKeys(value, depth = 0) {
  if (!value || typeof value !== 'object') return false;
  if (depth > 8) return true;
  return Object.keys(value).some(key => ['__proto__','prototype','constructor'].includes(key) || hasUnsafeKeys(value[key], depth + 1));
}

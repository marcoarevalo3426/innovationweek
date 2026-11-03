export const DEFAULT_FOOTER = Object.freeze({
  footer_text: 'For more information,',
  footer_link_text: 'Click here',
  footer_url: 'https://nepgroup.atlassian.net/wiki/x/AQBTyw',
});

export function isFooterUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password;
  } catch { return false; }
}

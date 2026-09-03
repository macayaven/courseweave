/** Parse an origin-only browser referrer without inventing a trust fallback. */
export function expectedParentOrigin(referrer: string = document.referrer): string | null {
  if (referrer.length === 0 || referrer.trim() !== referrer) return null;
  try {
    const parsed = new URL(referrer);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || parsed.username.length > 0
      || parsed.password.length > 0
      || parsed.pathname !== '/'
      || parsed.search.length > 0
      || parsed.hash.length > 0
      || parsed.origin === 'null'
    ) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

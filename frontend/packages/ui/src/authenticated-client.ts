/** Small shared primitive for applications whose launch token must stay in memory. */
export function authenticatedHeaders(token: string, headers: HeadersInit = {}): Headers {
  const result = new Headers(headers);
  result.set('Authorization', `Bearer ${token}`);
  return result;
}

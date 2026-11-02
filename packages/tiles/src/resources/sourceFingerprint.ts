const CREDENTIAL_QUERY_KEYS = new Set([
  'access_token', 'api_key', 'apikey', 'auth', 'authorization', 'expires',
  'expiry', 'expiration', 'id_token', 'key', 'key-pair-id', 'policy',
  'refresh_token', 'signature', 'sig', 'token',
  'se', 'si', 'sip', 'skv', 'sp', 'spr', 'sr', 'ss', 'st', 'sv',
]);

/**
 * Create a reusable resource-version fingerprint from a stable URL resource,
 * strong ETag, and byte length. Known credential and signing query fields are
 * excluded; other query parameters are sorted and included because they may
 * select the resource. The ETag is enforced on every subsequent range read.
 */
export async function createHttpEtagSourceFingerprint(
  source: string | URL,
  etag: string,
  contentLength: number,
): Promise<string> {
  const url = new URL(source.toString(), typeof location === 'undefined' ? 'http://localhost/' : location.href);
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new TypeError('An HTTP(S) source without embedded credentials is required for an ETag fingerprint.');
  }
  if (typeof etag !== 'string' || !isStrongHttpEtag(etag)) {
    throw new TypeError('A strong HTTP ETag is required for a persistent content-bounds index.');
  }
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
    throw new TypeError('The HTTP source must report a positive, safe-integer content length.');
  }
  if (!globalThis.crypto?.subtle) throw new Error('Source fingerprinting requires Web Crypto in a secure context.');
  const resourceQuery = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    const normalizedKey = key.toLowerCase();
    if (isCredentialQueryKey(normalizedKey)) continue;
    resourceQuery.append(key, value);
  }
  resourceQuery.sort();
  const query = resourceQuery.toString();
  const identity = `${url.origin}${url.pathname}${query ? `?${query}` : ''}\n${etag}\n${contentLength}`;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `http-etag-sha256:${hex}`;
}

function isStrongHttpEtag(value: string): boolean {
  return /^"(?:[\x21\x23-\x7e\x80-\xff])*"$/u.test(value);
}

function isCredentialQueryKey(key: string): boolean {
  return CREDENTIAL_QUERY_KEYS.has(key) || key.startsWith('x-amz-') || key.startsWith('x-goog-');
}

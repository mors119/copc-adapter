/**
 * Create a reusable resource-version fingerprint from a stable URL path,
 * strong ETag, and byte length. Query strings and credentials are excluded;
 * the ETag is separately enforced by Adapter on every subsequent range read.
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
  const identity = `${url.origin}${url.pathname}\n${etag}\n${contentLength}`;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `http-etag-sha256:${hex}`;
}

function isStrongHttpEtag(value: string): boolean {
  return /^"(?:[\x21\x23-\x7e\x80-\xff])*"$/u.test(value);
}

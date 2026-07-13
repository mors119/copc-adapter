import { Getter } from 'copc';

function isHttpSource(source: string): boolean {
  return source.startsWith('http://') || source.startsWith('https://');
}

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

export function createCopcGetter(source: string): Getter {
  if (isHttpSource(source)) {
    return Getter.http(source);
  }

  if (isBrowser()) {
    const resolvedUrl = new URL(source, window.location.href).toString();

    return Getter.http(resolvedUrl);
  }

  return Getter.create(source);
}

declare module 'node:fs/promises' {
  export function readFile(path: string): Promise<Uint8Array>;
}

declare module 'node:path' {
  export function dirname(path: string): string;
  export function resolve(...paths: string[]): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}

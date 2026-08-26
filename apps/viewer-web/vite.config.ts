import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';
import fs from 'node:fs';
import path from 'node:path';

function localSampleRangeMiddleware() {
  return {
    name: 'local-sample-range-requests',
    configureServer(server: { middlewares: { use: (handler: Function) => void } }) {
      server.middlewares.use((request: any, response: any, next: () => void) => {
        if (!request.url?.startsWith('/samples/') || !request.headers.range) {
          next();
          return;
        }

        const filename = path.basename(new URL(request.url, 'http://localhost').pathname);
        const filePath = path.resolve('public/samples', filename);
        if (!fs.existsSync(filePath)) {
          next();
          return;
        }

        const fileSize = fs.statSync(filePath).size;
        const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
        if (!match) {
          response.statusCode = 416;
          response.end();
          return;
        }

        const start = Number(match[1]);
        const end = Math.min(
          match[2] ? Number(match[2]) : fileSize - 1,
          fileSize - 1,
        );
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) {
          response.statusCode = 416;
          response.end();
          return;
        }

        response.statusCode = 206;
        response.setHeader('Accept-Ranges', 'bytes');
        response.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
        response.setHeader('Content-Length', end - start + 1);
        fs.createReadStream(filePath, { start, end }).pipe(response);
      });
    },
  };
}

export default defineConfig({
  plugins: [localSampleRangeMiddleware(), cesium()],
});

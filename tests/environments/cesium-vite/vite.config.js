import fs from 'node:fs';
import path from 'node:path';
import cesium from 'vite-plugin-cesium';
import { defineConfig } from 'vite';

function sampleRangeMiddleware() {
  function serveRange(request, response, next) {
    if (!request.url?.startsWith('/samples/') || !request.headers.range) {
      next();
      return;
    }

    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname !== '/samples/autzen.copc.laz') {
      next();
      return;
    }

    const filePath = path.resolve(process.cwd(), 'public/samples/autzen.copc.laz');
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
    const end = Math.min(match[2] ? Number(match[2]) : fileSize - 1, fileSize - 1);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) {
      response.statusCode = 416;
      response.end();
      return;
    }

    response.statusCode = 206;
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    response.setHeader('Content-Length', end - start + 1);
    response.setHeader('Content-Type', 'application/octet-stream');
    fs.createReadStream(filePath, { start, end }).pipe(response);
  }

  return {
    name: 'packed-consumer-sample-range-requests',
    configureServer(server) {
      server.middlewares.use(serveRange);
    },
    configurePreviewServer(server) {
      server.middlewares.use(serveRange);
    },
  };
}

export default defineConfig({
  plugins: [sampleRangeMiddleware(), cesium()],
});

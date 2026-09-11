import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sirv from 'sirv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = join(__dirname, '..', '..', 'agent-dev-client', 'build');

export function createStaticFileHandler(staticDir: string) {
  return sirv(staticDir, {
    dev: true,
    etag: true,
    single: true,
    gzip: true,
    brotli: true,
    setHeaders(res) {
      // Agent builds replace stable filenames such as main.js in place.
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    },
  });
}

export const serveStatic = createStaticFileHandler(STATIC_DIR);

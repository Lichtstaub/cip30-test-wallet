// Serves the demo under two CSP variants. The variant is the first path
// segment, the rest maps to files in this directory. Port is fixed, the
// Playwright config relies on it.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const port = 4173;

export const CSP = {
  strict: "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
  permissive: "default-src 'none'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
};

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const [, variant, ...rest] = url.pathname.split('/');
  const policy = CSP[variant];
  if (!policy) {
    res.writeHead(404).end('unknown variant, use /strict/ or /permissive/');
    return;
  }
  const file = rest.join('/') || 'index.html';
  try {
    const body = await readFile(join(root, file));
    res.writeHead(200, {
      'content-type': types[extname(file)] ?? 'application/octet-stream',
      'content-security-policy': policy,
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, () => console.log(`demo on http://localhost:${port}/strict/ and /permissive/`));

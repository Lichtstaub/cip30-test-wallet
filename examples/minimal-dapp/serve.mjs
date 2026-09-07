// Serves the demo under several CSP variants. The variant is the first path
// segment, the rest maps to files in this directory. Port is fixed for the
// Playwright config, tests create their own server on a free port.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CSP } from './csp.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const port = 4173;

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

// How each variant delivers its policy: as an enforced header, as a
// report-only header, or as a meta tag inside the document.
const variants = {
  strict: { header: CSP.strict },
  permissive: { header: CSP.permissive },
  'meta-strict': { meta: CSP.strict },
  'report-only': { reportOnly: CSP.strict },
};
export const VARIANTS = Object.keys(variants);

function withMeta(html, policy) {
  return html.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n  <meta http-equiv="Content-Security-Policy" content="${policy.replace(/"/g, '&quot;')}">`);
}

export function createDemoServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const [, variant, ...rest] = url.pathname.split('/');
    const mode = variants[variant];
    if (!mode) {
      res.writeHead(404).end(`unknown variant, use one of ${VARIANTS.map((v) => `/${v}/`).join(', ')}`);
      return;
    }
    if (rest.length === 0 && !url.pathname.endsWith('/')) {
      res.writeHead(302, { location: `${url.pathname}/${url.search}` });
      res.end();
      return;
    }
    const file = rest.join('/') || 'index.html';
    try {
      let body = await readFile(join(root, file));
      const headers = { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' };
      if (mode.header) headers['content-security-policy'] = mode.header;
      if (mode.reportOnly) headers['content-security-policy-report-only'] = mode.reportOnly;
      if (mode.meta && file === 'index.html') body = Buffer.from(withMeta(body.toString('utf8'), mode.meta));
      res.writeHead(200, headers);
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  createDemoServer().listen(port, '127.0.0.1', () => console.log(`demo on http://localhost:${port}/ with variants ${VARIANTS.join(', ')}`));
}

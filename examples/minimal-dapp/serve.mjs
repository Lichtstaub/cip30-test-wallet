// Serves the demo under several CSP variants. The variant is the first path
// segment, the rest maps to files in this directory. Port is fixed for the
// Playwright config, tests create their own server on a free port.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CSP } from './csp.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const port = 4173;

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

// The hashed variant pins both scripts by hash, in the policy and as SRI on the tags.
// Appending anything to those scripts breaks the page, which is what doctor must detect.
const sha = (buf) => `sha256-${createHash('sha256').update(buf).digest('base64')}`;

// The two script hashes never change while the server runs, computing them on every
// request to /hashed/ is wasted work, so they are computed once, lazily, and cached.
let hashedCache = null;
async function hashedScripts() {
  if (!hashedCache) {
    const app = await readFile(join(root, 'app.js'));
    const demoTx = await readFile(join(root, 'demo-tx.js'));
    hashedCache = { appHash: sha(app), demoTxHash: sha(demoTx) };
  }
  return hashedCache;
}

// How each variant delivers its policy: as an enforced header, as a
// report-only header, or as a meta tag inside the document. status-403
// answers every request with the strict document and an error status, to
// test doctor's handling of a bot wall or a broken deployment.
const variants = {
  strict: { header: CSP.strict },
  permissive: { header: CSP.permissive },
  'meta-strict': { meta: CSP.strict },
  'report-only': { reportOnly: CSP.strict },
  hashed: { hashed: true },
  'status-403': { header: CSP.strict, status: 403 },
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
    // status-403 always answers with the strict index.html, whatever path was requested.
    const file = mode.status ? 'index.html' : rest.join('/') || 'index.html';
    try {
      let body = await readFile(join(root, file));
      const headers = { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' };
      if (mode.header) headers['content-security-policy'] = mode.header;
      if (mode.reportOnly) headers['content-security-policy-report-only'] = mode.reportOnly;
      if (mode.meta && file === 'index.html') body = Buffer.from(withMeta(body.toString('utf8'), mode.meta));
      if (mode.hashed) {
        const { appHash, demoTxHash } = await hashedScripts();
        headers['content-security-policy'] = `default-src 'none'; script-src '${appHash}' '${demoTxHash}'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'`;
        if (file === 'index.html') {
          body = Buffer.from(
            body
              .toString('utf8')
              .replace('<script src="demo-tx.js">', `<script src="demo-tx.js" integrity="${demoTxHash}">`)
              .replace('<script src="app.js">', `<script src="app.js" integrity="${appHash}">`),
          );
        }
      }
      res.writeHead(mode.status ?? 200, headers);
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  createDemoServer().listen(port, '127.0.0.1', () => console.log(`demo on http://localhost:${port}/ with variants ${VARIANTS.join(', ')}`));
}

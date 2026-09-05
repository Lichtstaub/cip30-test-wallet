// Bundles src/core plus the page entry as self-contained files and fails
// when anything external, Node specific or WASM survives. This is the shape
// the page will receive through addInitScript, so it must stand alone.
import { build } from 'esbuild';

const result = await build({
  entryPoints: ['src/core/sign-tx.ts', 'src/core/ledger.ts', 'src/core/addresses.ts', 'src/page/index.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  write: false,
  outdir: 'dist',
  minify: false,
  logLevel: 'silent',
});

let failed = false;
for (const file of result.outputFiles) {
  const text = file.text;
  const kb = (text.length / 1024).toFixed(1);
  const problems = [];
  if (/\bfrom\s+["']node:/.test(text) || /require\(/.test(text)) problems.push('references node or require');
  if (/\bimport\s+[^;]*from\s+["'][^./]/.test(text)) problems.push('has an unresolved external import');
  if (/WebAssembly/.test(text)) problems.push('references WebAssembly');
  if (/\bBuffer\./.test(text)) problems.push('uses Buffer');
  if (/\beval\(/.test(text)) problems.push('uses eval');
  if (/new Function\(/.test(text)) problems.push('uses the Function constructor');
  if (text.length > 120 * 1024) problems.push(`is larger than 120 KB (${kb} KB)`);
  console.log(`${file.path.split('/').pop()}: ${kb} KB${problems.length ? ' FAIL ' + problems.join(', ') : ' ok'}`);
  if (problems.length) failed = true;
}
process.exit(failed ? 1 : 0);

// Bundles src/core plus the page entry as self-contained files and fails
// when anything external, Node specific or WASM survives. This is the shape
// the page will receive through addInitScript, so it must stand alone.
import { build } from 'esbuild';
import { PAGE_BUNDLE_MAX_BYTES, PAGE_BUNDLE_OPTIONS, PAGE_ENTRY } from './page-bundle.mjs';

const CORE_BUNDLE_MAX_BYTES = 120 * 1024;

const result = await build({
  ...PAGE_BUNDLE_OPTIONS,
  entryPoints: ['src/core/sign-tx.ts', 'src/core/requirements.ts', 'src/core/ledger.ts', 'src/core/addresses.ts', 'src/core/cose.ts', 'src/core/sign-data.ts', 'src/core/value.ts', 'src/core/select.ts', PAGE_ENTRY],
  format: 'esm',
  write: false,
  outdir: 'dist',
  logLevel: 'silent',
});

let failed = false;
for (const file of result.outputFiles) {
  const text = file.text;
  const kb = (text.length / 1024).toFixed(1);
  const problems = [];
  // esbuild names each output after its entry's basename, src/page/index.ts becomes index.js,
  // the only entry with that name, so this is how the page bundle is told apart from the core ones.
  const isPageEntry = file.path.split('/').pop() === 'index.js';
  const maxBytes = isPageEntry ? PAGE_BUNDLE_MAX_BYTES : CORE_BUNDLE_MAX_BYTES;
  if (/\bfrom\s+["']node:/.test(text) || /require\(/.test(text)) problems.push('references node or require');
  if (/\bimport\s+[^;]*from\s+["'][^./]/.test(text)) problems.push('has an unresolved external import');
  if (/WebAssembly/.test(text)) problems.push('references WebAssembly');
  if (/\bBuffer\./.test(text)) problems.push('uses Buffer');
  if (/\beval\(/.test(text)) problems.push('uses eval');
  if (/new Function\(/.test(text)) problems.push('uses the Function constructor');
  if (text.length > maxBytes) problems.push(`is larger than ${(maxBytes / 1024).toFixed(0)} KB (${kb} KB)`);
  console.log(`${file.path.split('/').pop()}: ${kb} KB${problems.length ? ' FAIL ' + problems.join(', ') : ' ok'}`);
  if (problems.length) failed = true;
}
process.exit(failed ? 1 : 0);

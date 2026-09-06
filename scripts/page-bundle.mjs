// The page entry point, its byte cap, and the esbuild options every script
// that bundles it shares, so the entry point and the settings never drift
// apart across the build, the bundle check and the bundle test.
export const PAGE_ENTRY = 'src/page/index.ts';

export const PAGE_BUNDLE_MAX_BYTES = 160 * 1024;

/** @type {import('esbuild').BuildOptions} */
export const PAGE_BUNDLE_OPTIONS = {
  entryPoints: [PAGE_ENTRY],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: false,
  legalComments: 'none',
};

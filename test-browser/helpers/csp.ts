export const VARIANTS = ['strict', 'permissive'] as const;
export type Variant = (typeof VARIANTS)[number];

export function url(variant: Variant, query = ''): string {
  return `/${variant}/${query ? `?${query}` : ''}`;
}

/** Init script that tries eval the way a mobile wallet's injector would and records the verdict. */
export const EVAL_PROBE = `
  try { new Function('return 1')(); window.__chwProbeEval = 'ok'; }
  catch (e) { window.__chwProbeEval = 'blocked'; }
`;

/** Init script that injects a stub CIP-30 provider, optionally after a delay. */
export function walletStub(delayMs = 0): string {
  const define = `
    window.cardano = window.cardano || {};
    window.cardano.chw = {
      apiVersion: '1', name: 'chw', icon: '', supportedExtensions: [],
      isEnabled: () => Promise.resolve(false),
      enable: () => Promise.resolve({ getNetworkId: () => Promise.resolve(0) }),
    };
  `;
  return delayMs > 0 ? `setTimeout(() => { ${define} }, ${delayMs});` : define;
}

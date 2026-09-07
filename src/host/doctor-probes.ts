import { pageBundle } from './bundle.js';
import { prepareWallet } from './config.js';

// Init scripts for the deep run. They are strings because Playwright serialises
// them into the page. The observation script defines an accessor pair on
// window.cardano so every read by the page is counted, while a wallet (real or
// injected) can still be assigned through the setter. Reads made by our own
// injection are excluded through the suspended flag.
export const OBSERVE_SCRIPT = `
(() => {
  const state = {
    firstAccessMs: null,
    count: 0,
    lastAccessMs: null,
    violations: [],
    routeProbeEval: null,
    routeProbeError: null,
    suspended: false,
    injectedAtMs: null,
    countAfterInjection: 0,
  };
  const t0 = performance.now();
  let value = undefined;
  Object.defineProperty(window, 'cardano', {
    configurable: true,
    enumerable: true,
    get() {
      if (!state.suspended) {
        const t = Math.round(performance.now() - t0);
        state.count += 1;
        if (state.firstAccessMs === null) state.firstAccessMs = t;
        state.lastAccessMs = t;
        if (state.injectedAtMs !== null) state.countAfterInjection += 1;
      }
      return value;
    },
    set(v) { value = v; },
  });
  document.addEventListener('securitypolicyviolation', (e) => {
    state.violations.push([e.violatedDirective, e.blockedURI, e.sourceFile || '', e.lineNumber || 0].join(':'));
  });
  state.markInjected = () => { state.injectedAtMs = Math.round(performance.now() - t0); };
  Object.defineProperty(window, '__chwDoctor', { value: state, configurable: true });
})();
`;

export const ROUTE_PROBE = `
;(function () {
  var d = window.__chwDoctor;
  if (!d) return;
  try {
    new Function('return 1')();
    d.routeProbeEval = 'ok';
  } catch (e) {
    if (e instanceof EvalError || /content security policy/i.test(String(e))) {
      d.routeProbeEval = 'blocked';
    } else {
      d.routeProbeEval = 'error';
      d.routeProbeError = String(e).slice(0, 200);
    }
  }
})();
`;

/** Bundle plus a delayed install of the default wallet, with the probe suspended while we touch window.cardano ourselves. */
export function injectScript(injectAfterMs: number): string {
  const config = JSON.stringify(prepareWallet().config);
  const install = `(() => { const d = globalThis.__chwDoctor; if (d) d.suspended = true; try { globalThis.__chwInit(${config}); } finally { if (d) d.suspended = false; } if (d) d.markInjected(); })()`;
  return injectAfterMs > 0 ? `${pageBundle()}\n;setTimeout(() => ${install}, ${injectAfterMs});` : `${pageBundle()}\n;${install};`;
}

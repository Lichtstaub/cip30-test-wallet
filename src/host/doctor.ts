import { collectPolicies, evaluateEval, hasHashSources, inlineHashConflict, isSecureContextUrl, type EvalVerdict, type Policy } from '../checks/csp.js';
import { addFinding, emptyReport, type DeepFacts, type DoctorReport } from '../checks/report.js';
import { OBSERVE_SCRIPT, ROUTE_PROBE, injectScript } from './doctor-probes.js';

export interface DoctorOptions {
  deep?: boolean;
  browser?: 'chromium' | 'firefox' | 'webkit';
  /** Selector to click after load, for pages that touch window.cardano only after a user action. */
  click?: string;
  /** Selector that must become visible once a wallet is detected. */
  expect?: string;
  /** Delay before the injected wallet appears, to test late injection handling. */
  injectAfterMs?: number;
  /** How long to wait after load and click before reading the probes. */
  settleMs?: number;
  /** Timeout for the static fetch, in milliseconds. */
  timeoutMs?: number;
  /** Test seam. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 15000;
const DOCTOR_USER_AGENT = 'Mozilla/5.0 (compatible; cardano-headless-wallet doctor)';

const EVAL_DETAIL =
  "The effective script policy has no 'unsafe-eval'. Mobile wallet in-app browsers inject their CIP-30 provider through eval, " +
  'confirmed for Eternl iOS, where \'wasm-unsafe-eval\' was not enough. Under this policy those wallets never appear in window.cardano ' +
  'and the dApp shows "no wallet installed", while desktop extensions are unaffected. Allowing eval weakens the policy, keeping it ' +
  'excludes those browsers. That is a decision for the team, doctor only reports the conflict.';

export function staticFindings(report: DoctorReport, policies: Policy[], verdict: EvalVerdict): void {
  if (report.secureContext === false) {
    addFinding(report, {
      id: 'no-secure-context',
      severity: 'error',
      title: 'not a secure context',
      detail: 'Wallets inject only into secure contexts. Eternl mobile opens https links only. Serve the dApp over https.',
    });
  }
  const enforced = policies.filter((p) => p.enforced);
  if (policies.some((p) => !p.enforced)) {
    addFinding(report, {
      id: 'report-only-csp',
      severity: 'info',
      title: 'a report-only policy is present',
      detail: 'Content-Security-Policy-Report-Only never blocks anything. It is listed for completeness and ignored for the eval verdict.',
    });
  }
  if (enforced.length === 0) {
    addFinding(report, {
      id: 'no-enforced-csp',
      severity: 'info',
      title: 'no enforced content security policy',
      detail: 'Nothing restricts scripts, wallet injection through eval is not blocked by policy.',
    });
  } else if (!verdict.allowed) {
    const where = verdict.blockedBy.map((b) => `${b.directive} from the ${b.policy.source} policy`).join(', ');
    addFinding(report, { id: 'eval-blocked', severity: 'warning', title: `eval is blocked by ${where}`, detail: EVAL_DETAIL });
  } else if (verdict.unrestricted) {
    addFinding(report, {
      id: 'eval-unrestricted',
      severity: 'info',
      title: 'the policy does not govern scripts',
      detail: 'No script-src and no default-src in any enforced policy, eval is not restricted.',
    });
  }
  for (const c of inlineHashConflict(policies)) {
    addFinding(report, {
      id: 'inline-hash-conflict',
      severity: 'info',
      title: `'unsafe-inline' is ignored in ${c.directive}`,
      detail: 'Browsers ignore \'unsafe-inline\' as soon as a hash or nonce is present in the same directive (CSP level 2). A wallet that injects through an inline script is blocked here, and relaxing \'unsafe-inline\' cannot change that without dropping the hashes.',
    });
  }
}

export async function runDoctor(url: string, options: DoctorOptions = {}): Promise<DoctorReport> {
  const report = emptyReport(url);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      redirect: 'follow',
      headers: { accept: 'text/html', 'user-agent': DOCTOR_USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e instanceof Error && e.name === 'TimeoutError') {
      report.errors.push(`fetch of ${url} timed out after ${timeoutMs} ms`);
    } else {
      report.errors.push(`could not fetch ${url}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return report;
  }
  const finalUrl = response.url && response.url.length > 0 ? response.url : url;
  report.finalUrl = finalUrl;
  report.status = response.status;
  report.contentType = response.headers.get('content-type');
  report.secureContext = isSecureContextUrl(new URL(finalUrl));
  const html = await response.text();
  const headers: Array<[string, string]> = [];
  response.headers.forEach((value, name) => headers.push([name, value]));
  const policies = collectPolicies({ headers, html });
  report.policies = policies.map((p) => ({ source: p.source, enforced: p.enforced, raw: p.raw }));
  const verdict = evaluateEval(policies);
  report.evalAllowed = verdict.allowed;
  staticFindings(report, policies, verdict);
  if (report.status !== null && (report.status < 200 || report.status > 299)) {
    addFinding(report, {
      id: 'http-status',
      severity: 'error',
      title: `the server answered ${report.status}`,
      detail:
        'The analysis below describes whatever the server returned (a challenge page, an error page, a redirect target), not necessarily the dApp. Node fetch sends no browser user agent, bot walls often answer it with a challenge.',
    });
  }
  if (report.contentType !== null && !report.contentType.includes('text/html')) {
    addFinding(report, {
      id: 'not-html',
      severity: 'warning',
      title: `the response content type is ${report.contentType}, not text/html`,
      detail: 'The policies above were read from a non-HTML response. Meta tags could not exist there, so only header policies are complete.',
    });
  }

  if (options.deep) {
    try {
      await deepRun(report, policies, options);
    } catch (e) {
      report.errors.push(`deep run failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return report;
}

interface ObservedState {
  firstAccessMs: number | null;
  count: number;
  lastAccessMs: number | null;
  violations: string[];
  routeProbeEval: 'ok' | 'blocked' | 'error' | null;
  routeProbeError: string | null;
  injectedAtMs: number | null;
  countAfterInjection: number;
}

const CLICK_TIMEOUT_MS = 5000;

/** Escapes a string for literal use inside a RegExp, so a query string or path segment cannot be misread as a glob or regex pattern. */
function escapeForRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Clicks the selector, swallowing a failure into a message instead of aborting the run, the deep run still reports whatever it observed. */
async function tryClick(page: PageLike, selector: string): Promise<string | null> {
  try {
    await page.click(selector, { timeout: CLICK_TIMEOUT_MS });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function deepRun(report: DoctorReport, policies: Policy[], options: DoctorOptions): Promise<void> {
  const browserName = options.browser ?? 'chromium';
  const settleMs = options.settleMs ?? 1500;
  const injectAfterMs = options.injectAfterMs ?? 0;
  const url = report.finalUrl ?? report.url;
  const origin = new URL(url).origin;

  let launchers: { chromium: unknown; firefox: unknown; webkit: unknown };
  try {
    launchers = (await import('@playwright/test')) as never;
  } catch {
    throw new Error('--deep needs @playwright/test installed (npm i -D @playwright/test && npx playwright install)');
  }
  const launcher = launchers[browserName] as { launch(): Promise<{ newContext(): Promise<unknown>; close(): Promise<void> }> };
  const browser = await launcher.launch();
  try {
    // Load 1: observe. No probe, no wallet, so violations and accesses are the page's own.
    const context1 = (await browser.newContext()) as { newPage(): Promise<PageLike>; close(): Promise<void> };
    const page1 = await context1.newPage();
    await page1.addInitScript(OBSERVE_SCRIPT);
    await page1.goto(url, { waitUntil: 'load' });
    const loadedUrl = page1.url();
    let clickAtMs: number | null = null;
    let clickError: string | null = null;
    if (options.click) {
      clickAtMs = (await page1.evaluate(() => Math.round(performance.now()))) as number;
      clickError = await tryClick(page1, options.click);
    }
    await page1.waitForTimeout(settleMs);
    const observed = (await page1.evaluate(() => (window as unknown as { __chwDoctor: ObservedState }).__chwDoctor)) as ObservedState;
    const scripts = (await page1.evaluate(() =>
      Array.from(document.querySelectorAll('script[src]')).map((s) => ({ src: (s as HTMLScriptElement).src, integrity: s.getAttribute('integrity') })),
    )) as Array<{ src: string; integrity: string | null }>;
    await context1.close();

    // Decide whether the eval probe can be appended to a first-party script.
    let routeProbe: DeepFacts['routeProbe'] = 'skipped';
    let routeProbeReason: string | null = null;
    let target: string | null = null;
    const firstParty = scripts.filter((s) => new URL(s.src).origin === origin);
    if (hasHashSources(policies)) routeProbeReason = 'script-src pins scripts by hash, appending a probe would break the page';
    else if (firstParty.length === 0) routeProbeReason = 'no external first-party script to append the probe to';
    else {
      const candidate = firstParty.find((s) => !s.integrity);
      if (!candidate) routeProbeReason = 'every first-party script carries an integrity attribute';
      else target = candidate.src;
    }

    // Load 2: probe. Route-appended eval probe, injected wallet, click, expect.
    const context2 = (await browser.newContext()) as { newPage(): Promise<PageLike>; close(): Promise<void> };
    const page2 = await context2.newPage();
    await page2.addInitScript(OBSERVE_SCRIPT);
    await page2.addInitScript(injectScript(injectAfterMs));
    let routed = false;
    if (target) {
      const pattern = new RegExp(`^${escapeForRegExp(target)}$`);
      await page2.route(pattern, async (route) => {
        routed = true;
        const response = await route.fetch();
        await route.fulfill({ response, body: (await response.text()) + ROUTE_PROBE });
      });
    }
    await page2.goto(url, { waitUntil: 'load' });
    if (options.click) {
      const err = await tryClick(page2, options.click);
      if (err) clickError = err;
    }
    const settleWindow = Math.max(settleMs, injectAfterMs + 500);
    let expectVisible: boolean | null = null;
    if (options.expect) {
      expectVisible = await page2.waitForSelector(options.expect, { state: 'visible', timeout: settleWindow }).then(
        () => true,
        () => false,
      );
    } else {
      await page2.waitForTimeout(settleWindow);
    }
    const probed = (await page2.evaluate(() => (window as unknown as { __chwDoctor: ObservedState }).__chwDoctor)) as ObservedState;
    const providerVisible = (await page2.evaluate(() => {
      const c = (window as unknown as { cardano?: Record<string, unknown> }).cardano;
      return Boolean(c && c['chw']);
    })) as boolean;
    await context2.close();

    if (target) {
      if (!routed) {
        routeProbe = 'skipped';
        routeProbeReason = 'our interception never matched the script url';
      } else if (probed.routeProbeEval === null) {
        routeProbe = 'skipped';
        routeProbeReason = 'the script was intercepted but the probe did not execute';
      } else if (probed.routeProbeEval === 'error') {
        routeProbe = 'error';
        routeProbeReason = probed.routeProbeError;
      } else {
        routeProbe = probed.routeProbeEval;
      }
    }

    report.deep = {
      browser: browserName,
      loadedUrl,
      clickSelector: options.click ?? null,
      clickAtMs,
      settleMs,
      routed,
      access: { firstAccessMs: observed.firstAccessMs, count: observed.count, lastAccessMs: observed.lastAccessMs },
      violations: observed.violations.filter((v) => v.startsWith('script-src') || v.startsWith('default-src')),
      routeProbe,
      routeProbeReason,
      injection: {
        injectedAfterMs: injectAfterMs,
        injectedAtMs: probed.injectedAtMs,
        providerVisible,
        accessesAfterInjection: probed.countAfterInjection,
        expectSelector: options.expect ?? null,
        expectVisible,
        expectWaitMs: options.expect ? settleWindow : null,
      },
    };
    deepFindings(report);
    if (clickError && options.click) {
      addFinding(report, {
        id: 'click-failed',
        severity: 'warning',
        title: `the click on ${options.click} did not complete`,
        detail: `page.click('${options.click}', { timeout: ${CLICK_TIMEOUT_MS} }) failed: ${clickError}. Continuing with the observation load's data.`,
      });
    }
  } finally {
    await browser.close();
  }
}

interface PageLike {
  addInitScript(script: string): Promise<void>;
  goto(url: string, options: { waitUntil: 'load' }): Promise<unknown>;
  url(): string;
  click(selector: string, options: { timeout: number }): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  waitForSelector(selector: string, options: { state: 'visible'; timeout: number }): Promise<unknown>;
  evaluate(fn: () => unknown): Promise<unknown>;
  route(
    pattern: RegExp,
    handler: (route: { fetch(): Promise<{ text(): Promise<string> }>; fulfill(opts: { response: unknown; body: string }): Promise<void> }) => Promise<void>,
  ): Promise<void>;
}

function deepFindings(report: DoctorReport): void {
  const d = report.deep!;
  if (d.loadedUrl && report.finalUrl && d.loadedUrl !== report.finalUrl) {
    addFinding(report, {
      id: 'deep-url-differs',
      severity: 'info',
      title: `the browser ended up on ${d.loadedUrl}, the measurements describe that page`,
      detail: `the static fetch was for ${report.finalUrl}. A session-aware app, a redirect, or a client-side navigation can send the browser elsewhere after load.`,
    });
  }
  if (d.access.count === 0) {
    addFinding(report, {
      id: 'no-cip30-access',
      severity: 'info',
      title: 'no CIP-30 access observed during the executed scenario',
      detail:
        `The page did not read window.cardano while loading${d.clickSelector ? ` and after clicking ${d.clickSelector}` : ''}. ` +
        (d.clickSelector ? 'It may read it after a different user action.' : 'It may do so after a user action, pass --click <selector> to run one.') +
        ' The static findings above stand.',
    });
  } else if (d.access.count === 1) {
    const afterClick = d.clickSelector !== null && d.clickAtMs !== null && d.access.firstAccessMs !== null && d.access.firstAccessMs > d.clickAtMs;
    addFinding(report, {
      id: 'single-scan',
      severity: 'warning',
      title: `window.cardano was read once, ${d.access.firstAccessMs} ms after load${afterClick ? `, after the click on ${d.clickSelector}` : ''}`,
      detail: 'One read and no retry within the observation window. A wallet that injects later than that read is not proven to be found. Use --inject-after <ms> together with --expect <selector> to test detection of a late wallet.',
    });
  }
  if (d.routeProbe === 'skipped') {
    addFinding(report, {
      id: 'eval-probe-skipped',
      severity: 'info',
      title: 'the in-page eval probe did not run',
      detail: `${d.routeProbeReason ?? 'no reason recorded'}. The eval verdict above rests on the policy text alone.`,
    });
  } else if (d.routeProbe === 'error') {
    addFinding(report, {
      id: 'eval-probe-error',
      severity: 'info',
      title: 'the in-page eval probe raised an unexpected error',
      detail: `${d.routeProbeReason ?? 'no error recorded'}. The eval verdict above rests on the policy text alone.`,
    });
  } else if (report.evalAllowed !== null && (d.routeProbe === 'ok') !== report.evalAllowed) {
    addFinding(report, {
      id: 'eval-verdict-mismatch',
      severity: 'warning',
      title: `the policy says eval is ${report.evalAllowed ? 'allowed' : 'blocked'} but a first-party script observed ${d.routeProbe}`,
      detail: 'The browser and the policy text disagree. A header that differs between the fetch and the browser load (caching, edge rules, a service worker) is the usual cause.',
    });
  }
  if (!d.injection.providerVisible) {
    addFinding(report, {
      id: 'injection-failed',
      severity: 'error',
      title: 'the injected wallet never appeared in window.cardano',
      detail: 'Something on the page replaced or froze window.cardano after our init script ran. Real extensions would be affected the same way.',
    });
  } else if (d.injection.expectSelector && d.injection.expectVisible === false) {
    addFinding(report, {
      id: 'wallet-not-detected',
      severity: 'warning',
      title: `the wallet was injected at ${d.injection.injectedAtMs} ms but ${d.injection.expectSelector} was not visible within ${d.injection.expectWaitMs} ms`,
      detail: `The page read window.cardano ${d.injection.accessesAfterInjection} time${d.injection.accessesAfterInjection === 1 ? '' : 's'} after the injection. Zero means it never looked again, use --settle to widen the window if the dApp starts its scan late.`,
    });
  }
}

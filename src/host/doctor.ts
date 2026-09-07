import { collectPolicies, evaluateEval, inlineHashConflict, isSecureContextUrl, type EvalVerdict, type Policy } from '../checks/csp.js';
import { addFinding, emptyReport, type DoctorReport } from '../checks/report.js';

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
  /** Test seam. */
  fetchImpl?: typeof fetch;
}

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
  let response: Response;
  try {
    response = await fetchImpl(url, { redirect: 'follow', headers: { accept: 'text/html' } });
  } catch (e) {
    report.errors.push(`could not fetch ${url}: ${e instanceof Error ? e.message : String(e)}`);
    return report;
  }
  const finalUrl = response.url && response.url.length > 0 ? response.url : url;
  report.finalUrl = finalUrl;
  report.secureContext = isSecureContextUrl(new URL(finalUrl));
  const html = await response.text();
  const headers: Array<[string, string]> = [];
  response.headers.forEach((value, name) => headers.push([name, value]));
  const policies = collectPolicies({ headers, html });
  report.policies = policies.map((p) => ({ source: p.source, enforced: p.enforced, raw: p.raw }));
  const verdict = evaluateEval(policies);
  report.evalAllowed = verdict.allowed;
  staticFindings(report, policies, verdict);

  if (options.deep) throw new Error('deep mode arrives with task 4');
  return report;
}

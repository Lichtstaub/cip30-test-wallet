export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
}

export interface PolicySummary {
  source: 'header' | 'meta';
  enforced: boolean;
  raw: string;
}

export interface DeepFacts {
  browser: string;
  access: { firstAccessMs: number | null; count: number; lastAccessMs: number | null };
  /** violatedDirective:blockedURI:sourceFile:line, from the observation load only. */
  violations: string[];
  routeProbe: 'ok' | 'blocked' | 'skipped';
  routeProbeReason: string | null;
  injection: {
    injectedAfterMs: number;
    providerVisible: boolean;
    accessesAfterInjection: number;
    expectSelector: string | null;
    expectVisible: boolean | null;
  };
}

export interface DoctorReport {
  url: string;
  finalUrl: string | null;
  secureContext: boolean | null;
  policies: PolicySummary[];
  evalAllowed: boolean | null;
  findings: Finding[];
  deep: DeepFacts | null;
  /** Problems with the run itself, not with the site. Non-empty means exit code 2. */
  errors: string[];
}

export function emptyReport(url: string): DoctorReport {
  return { url, finalUrl: null, secureContext: null, policies: [], evalAllowed: null, findings: [], deep: null, errors: [] };
}

export function addFinding(report: DoctorReport, finding: Finding): void {
  report.findings.push(finding);
}

export function exitCode(report: DoctorReport): 0 | 1 | 2 {
  if (report.errors.length > 0) return 2;
  return report.findings.some((f) => f.severity !== 'info') ? 1 : 0;
}

export function formatJson(report: DoctorReport): string {
  return JSON.stringify(report, null, 2);
}

export function formatHuman(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`cardano-headless-wallet doctor`);
  lines.push(`url: ${report.url}`);
  if (report.finalUrl && report.finalUrl !== report.url) lines.push(`final url: ${report.finalUrl}`);
  if (report.secureContext !== null) lines.push(`secure context: ${report.secureContext ? 'yes' : 'no'}`);
  if (report.policies.length === 0) lines.push('csp: none');
  for (const p of report.policies) lines.push(`csp (${p.source}${p.enforced ? '' : ', report-only'}): ${p.raw}`);
  if (report.evalAllowed !== null) lines.push(`eval by policy: ${report.evalAllowed ? 'allowed' : 'blocked'}`);
  if (report.deep) {
    const d = report.deep;
    lines.push(`browser: ${d.browser}`);
    lines.push(
      d.access.count === 0
        ? 'window.cardano: no access observed during the executed scenario'
        : `window.cardano: first access after ${d.access.firstAccessMs} ms, ${d.access.count} access${d.access.count === 1 ? '' : 'es'}, last after ${d.access.lastAccessMs} ms`,
    );
    lines.push(`page violations (script-src): ${d.violations.length === 0 ? 'none' : d.violations.join(' | ')}`);
    lines.push(`eval probe in a first-party script: ${d.routeProbe}${d.routeProbeReason ? ` (${d.routeProbeReason})` : ''}`);
    lines.push(
      `injected wallet after ${d.injection.injectedAfterMs} ms: ${d.injection.providerVisible ? 'present in window.cardano' : 'not present'}, ${d.injection.accessesAfterInjection} page access${d.injection.accessesAfterInjection === 1 ? '' : 'es'} after injection` +
        (d.injection.expectSelector ? `, ${d.injection.expectSelector} ${d.injection.expectVisible ? 'visible' : 'not visible'}` : ''),
    );
  }
  lines.push('');
  if (report.findings.length === 0 && report.errors.length === 0) lines.push('no findings');
  for (const f of report.findings) {
    lines.push(`[${f.severity}] ${f.id}: ${f.title}`);
    lines.push(`  ${f.detail}`);
  }
  for (const e of report.errors) lines.push(`[error] run: ${e}`);
  return lines.join('\n');
}

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
  /** The url the browser was actually on after load 1, which can differ from finalUrl (redirect, session, client-side navigation). */
  loadedUrl: string | null;
  clickSelector: string | null;
  /** performance.now() in load 1 right before the click, null when no click was requested. */
  clickAtMs: number | null;
  settleMs: number;
  /** Whether the route interception for the eval probe matched any request at all. */
  routed: boolean;
  access: { firstAccessMs: number | null; count: number; lastAccessMs: number | null };
  /** violatedDirective:blockedURI:sourceFile:line, from the observation load only. */
  violations: string[];
  routeProbe: 'ok' | 'blocked' | 'skipped' | 'error';
  routeProbeReason: string | null;
  injection: {
    injectedAfterMs: number;
    /** performance.now() when the wallet install actually ran, from the probe load. */
    injectedAtMs: number | null;
    providerVisible: boolean;
    accessesAfterInjection: number;
    expectSelector: string | null;
    expectVisible: boolean | null;
    expectWaitMs: number | null;
  };
}

export interface DoctorReport {
  url: string;
  finalUrl: string | null;
  status: number | null;
  contentType: string | null;
  secureContext: boolean | null;
  policies: PolicySummary[];
  evalAllowed: boolean | null;
  findings: Finding[];
  deep: DeepFacts | null;
  /** Problems with the run itself, not with the site. Non-empty means exit code 2. */
  errors: string[];
}

export function emptyReport(url: string): DoctorReport {
  return {
    url,
    finalUrl: null,
    status: null,
    contentType: null,
    secureContext: null,
    policies: [],
    evalAllowed: null,
    findings: [],
    deep: null,
    errors: [],
  };
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

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
const WRAP_WIDTH = 88;

function plural(n: number, word: string, suffix = 's'): string {
  return `${n} ${word}${n === 1 ? '' : suffix}`;
}

/** Label and value rows of one section, labels padded to a shared column. */
function section(title: string, rows: Array<[string, string]>): string[] {
  const width = Math.max(...rows.map(([label]) => label.length));
  return [title, ...rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`.trimEnd())];
}

/** Greedy word wrap, every line prefixed with indent. */
function wrap(text: string, indent: string): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && indent.length + line.length + 1 + word.length > WRAP_WIDTH) {
      out.push(indent + line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(indent + line);
  return out;
}

/** One directive per row, so a long policy stays readable. */
function policyRows(p: PolicySummary): Array<[string, string]> {
  const label = `${p.source}${p.enforced ? '' : ', report-only'}`;
  const directives = p.raw
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean);
  if (directives.length === 0) return [[label, '(empty)']];
  return directives.map((d, i) => [i === 0 ? label : '', d]);
}

export function formatHuman(report: DoctorReport): string {
  const blocks: string[][] = [];
  blocks.push([`cip30-test-wallet doctor  ${report.url}`]);

  const page: Array<[string, string]> = [];
  if (report.finalUrl && report.finalUrl !== report.url) page.push(['final url', report.finalUrl]);
  if (report.status !== null) page.push(['status', String(report.status)]);
  if (report.contentType !== null) page.push(['content type', report.contentType]);
  if (report.secureContext !== null) page.push(['secure context', report.secureContext ? 'yes' : 'no']);
  if (page.length > 0) blocks.push(section('Page', page));

  if (report.finalUrl !== null) {
    const csp: Array<[string, string]> = report.policies.length === 0 ? [['policy', 'none']] : report.policies.flatMap(policyRows);
    if (report.evalAllowed !== null) csp.push(['eval', report.evalAllowed ? 'allowed by policy' : 'blocked by policy']);
    blocks.push(section('Content security policy', csp));
  }

  if (report.deep) {
    const d = report.deep;
    const deep: Array<[string, string]> = [];
    if (d.loadedUrl && d.loadedUrl !== report.finalUrl) deep.push(['loaded url', d.loadedUrl]);
    if (d.clickSelector) deep.push(['click', d.clickSelector]);
    deep.push([
      'window.cardano',
      d.access.count === 0
        ? 'no access observed during the executed scenario'
        : `first access after ${d.access.firstAccessMs} ms, ${plural(d.access.count, 'access', 'es')}, last after ${d.access.lastAccessMs} ms`,
    ]);
    if (d.violations.length === 0) deep.push(['violations', 'none (script-src, default-src)']);
    else d.violations.forEach((v, i) => deep.push([i === 0 ? 'violations' : '', v]));
    deep.push(['eval probe', `${d.routeProbe}${d.routeProbeReason ? ` (${d.routeProbeReason})` : ''}`]);
    deep.push([
      'injection',
      `wallet injected at ${d.injection.injectedAtMs} ms, ${d.injection.providerVisible ? 'present in window.cardano' : 'not present'}, ${plural(d.injection.accessesAfterInjection, 'page read')} after that`,
    ]);
    if (d.injection.expectSelector) {
      deep.push([
        'expect',
        `${d.injection.expectSelector} ${d.injection.expectVisible ? 'visible' : 'not visible'} within ${d.injection.expectWaitMs} ms`,
      ]);
    }
    blocks.push(section(`Deep run (${d.browser})`, deep));
  }

  const findings = [...report.findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  if (findings.length > 0) {
    const counts = (['error', 'warning', 'info'] as const)
      .map((s) => [s, findings.filter((f) => f.severity === s).length] as const)
      .filter(([, n]) => n > 0)
      .map(([s, n]) => plural(n, s, s === 'info' ? '' : 's'));
    const lines = [`Findings (${counts.join(', ')})`];
    findings.forEach((f, i) => {
      if (i > 0) lines.push('');
      lines.push(`  [${f.severity}] ${f.id}: ${f.title}`);
      lines.push(...wrap(f.detail, '    '));
    });
    blocks.push(lines);
  }

  if (report.errors.length > 0) {
    blocks.push(['Run errors', ...report.errors.flatMap((e) => wrap(e, '  '))]);
  }

  const code = exitCode(report);
  blocks.push([
    code === 2
      ? 'Result: the run failed, exit 2'
      : code === 1
        ? 'Result: findings above info, exit 1'
        : `Result: ${findings.length === 0 ? 'no findings' : 'nothing above info'}, exit 0`,
  ]);

  return blocks.map((b) => b.join('\n')).join('\n\n');
}

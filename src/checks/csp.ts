// Pure CSP reasoning. No IO here, the host hands in headers and html.
// Only the parts of CSP that matter for wallet injection are modelled:
// which directive governs eval, whether it allows it, and whether a hash
// or nonce makes 'unsafe-inline' a dead letter.

export interface Policy {
  source: 'header' | 'meta';
  enforced: boolean;
  raw: string;
  directives: Map<string, string[]>;
}

export function parsePolicy(raw: string, source: 'header' | 'meta', enforced: boolean): Policy {
  const directives = new Map<string, string[]>();
  for (const part of raw.split(';')) {
    const tokens = part.trim().split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) continue;
    const [name, ...sources] = tokens;
    directives.set(name!.toLowerCase(), sources);
  }
  return { source, enforced, raw: raw.trim(), directives };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Every <meta http-equiv="Content-Security-Policy" content="..."> in the document, attribute order independent. */
function metaPolicies(html: string): string[] {
  const out: string[] = [];
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const equiv = /http-equiv\s*=\s*["']?\s*content-security-policy\s*["']?/i.test(tag);
    if (!equiv) continue;
    const content = /content\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag);
    const value = content?.[2] ?? content?.[3];
    if (value !== undefined) out.push(decodeEntities(value));
  }
  return out;
}

export function collectPolicies(input: { headers: Array<[string, string]>; html: string }): Policy[] {
  const policies: Policy[] = [];
  for (const [name, value] of input.headers) {
    const lower = name.toLowerCase();
    const enforced = lower === 'content-security-policy';
    if (!enforced && lower !== 'content-security-policy-report-only') continue;
    for (const single of value.split(',')) {
      if (single.trim().length > 0) policies.push(parsePolicy(single, 'header', enforced));
    }
  }
  for (const meta of metaPolicies(input.html)) policies.push(parsePolicy(meta, 'meta', true));
  return policies;
}

/** The directive that governs eval in this policy, or undefined when nothing restricts scripts. */
function governing(policy: Policy): { directive: 'script-src' | 'default-src'; sources: string[] } | undefined {
  const script = policy.directives.get('script-src');
  if (script) return { directive: 'script-src', sources: script };
  const fallback = policy.directives.get('default-src');
  if (fallback) return { directive: 'default-src', sources: fallback };
  return undefined;
}

export interface EvalVerdict {
  allowed: boolean;
  /** True when no enforced policy governs scripts at all. */
  unrestricted: boolean;
  blockedBy: Array<{ policy: Policy; directive: 'script-src' | 'default-src' }>;
}

/** Enforced policies combine as an intersection: eval runs only if every one allows it. */
export function evaluateEval(policies: Policy[]): EvalVerdict {
  const blockedBy: EvalVerdict['blockedBy'] = [];
  let governed = false;
  for (const policy of policies) {
    if (!policy.enforced) continue;
    const g = governing(policy);
    if (!g) continue;
    governed = true;
    if (!g.sources.includes("'unsafe-eval'")) blockedBy.push({ policy, directive: g.directive });
  }
  return { allowed: blockedBy.length === 0, unrestricted: !governed, blockedBy };
}

const HASH_OR_NONCE = /^'(sha256|sha384|sha512|nonce)-/i;

export function inlineHashConflict(policies: Policy[]): Array<{ policy: Policy; directive: string }> {
  const out: Array<{ policy: Policy; directive: string }> = [];
  for (const policy of policies) {
    if (!policy.enforced) continue;
    const g = governing(policy);
    if (!g) continue;
    if (g.sources.includes("'unsafe-inline'") && g.sources.some((s) => HASH_OR_NONCE.test(s))) {
      out.push({ policy, directive: g.directive });
    }
  }
  return out;
}

/** True when any enforced governing directive pins scripts by hash, which forbids appending to them. */
export function hasHashSources(policies: Policy[]): boolean {
  return policies.some((policy) => {
    if (!policy.enforced) return false;
    const g = governing(policy);
    return g !== undefined && g.sources.some((s) => /^'sha(256|384|512)-/i.test(s));
  });
}

export function isSecureContextUrl(url: URL): boolean {
  if (url.protocol === 'https:') return true;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost');
}

import { describe, expect, it } from 'vitest';
import {
  collectPolicies,
  evaluateEval,
  hasHashSources,
  inlineHashConflict,
  isSecureContextUrl,
  parsePolicy,
} from '../src/checks/csp.js';

const strict = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'";
const permissive = "default-src 'none'; script-src 'self' 'unsafe-eval'";

describe('parsePolicy', () => {
  it('splits directives and lowercases names', () => {
    const p = parsePolicy("Script-Src 'self' https://cdn.example;  img-src data:", 'header', true);
    expect(p.directives.get('script-src')).toEqual(["'self'", 'https://cdn.example']);
    expect(p.directives.get('img-src')).toEqual(['data:']);
    expect(p.enforced).toBe(true);
    expect(p.source).toBe('header');
  });

  it('keeps an empty directive as an empty list', () => {
    expect(parsePolicy('sandbox; script-src', 'meta', true).directives.get('sandbox')).toEqual([]);
  });

  it('keeps the first occurrence of a repeated directive (CSP3)', () => {
    const p = parsePolicy("script-src 'self'; script-src 'self' 'unsafe-eval'", 'header', true);
    expect(p.directives.get('script-src')).toEqual(["'self'"]);
    expect(evaluateEval([p]).allowed).toBe(false);
  });

  it('matches unsafe-eval and unsafe-inline case-insensitively, sources stay as written', () => {
    const p = parsePolicy("script-src 'self' 'UNSAFE-EVAL'", 'header', true);
    expect(evaluateEval([p]).allowed).toBe(true);
    expect(p.directives.get('script-src')).toEqual(["'self'", "'UNSAFE-EVAL'"]);
  });
});

describe('collectPolicies', () => {
  it('reads enforced headers, report-only headers and meta tags', () => {
    const policies = collectPolicies({
      headers: [
        ['Content-Security-Policy', strict],
        ['content-security-policy-report-only', permissive],
        ['x-other', 'ignored'],
      ],
      html: `<html><head><meta charset="utf-8"><META content="script-src 'self' 'unsafe-eval'" http-equiv="Content-Security-Policy"></head></html>`,
    });
    expect(policies.map((p) => [p.source, p.enforced])).toEqual([
      ['header', true],
      ['header', false],
      ['meta', true],
    ]);
  });

  it('splits comma-separated policies in one header into several', () => {
    const policies = collectPolicies({ headers: [['content-security-policy', `${strict}, ${permissive}`]], html: '' });
    expect(policies).toHaveLength(2);
    expect(policies[1]!.directives.get('script-src')).toContain("'unsafe-eval'");
  });

  it('decodes html entities in a meta content attribute', () => {
    const policies = collectPolicies({ headers: [], html: `<meta http-equiv="content-security-policy" content="script-src &#39;self&#39; &quot;x&quot;">` });
    expect(policies[0]!.directives.get('script-src')).toEqual(["'self'", '"x"']);
  });

  it('does not split on a comma inside a directive value, only between policies', () => {
    const oneHeader = collectPolicies({
      headers: [['content-security-policy', "default-src 'self'; script-src 'self' 'unsafe-eval'; report-uri https://x.example/r?a=1,b=2"]],
      html: '',
    });
    expect(oneHeader).toHaveLength(1);
    expect(oneHeader[0]!.directives.size).toBe(3);

    const twoPolicies = collectPolicies({ headers: [['content-security-policy', `${strict}, ${permissive}`]], html: '' });
    expect(twoPolicies).toHaveLength(2);
  });
});

describe('evaluateEval', () => {
  it('is blocked when an enforced script-src lacks unsafe-eval', () => {
    const v = evaluateEval([parsePolicy(strict, 'header', true)]);
    expect(v.allowed).toBe(false);
    expect(v.blockedBy[0]!.directive).toBe('script-src');
  });

  it('is allowed when every enforced policy allows eval', () => {
    expect(evaluateEval([parsePolicy(permissive, 'header', true)]).allowed).toBe(true);
  });

  it('is the intersection of several enforced policies', () => {
    const v = evaluateEval([parsePolicy(permissive, 'header', true), parsePolicy(strict, 'meta', true)]);
    expect(v.allowed).toBe(false);
    expect(v.blockedBy[0]!.policy.source).toBe('meta');
  });

  it('falls back to default-src and ignores script-src-elem', () => {
    const v = evaluateEval([parsePolicy("default-src 'self'; script-src-elem 'self' 'unsafe-eval'", 'header', true)]);
    expect(v.allowed).toBe(false);
    expect(v.blockedBy[0]!.directive).toBe('default-src');
  });

  it('ignores report-only policies and reports unrestricted when nothing governs eval', () => {
    const v = evaluateEval([parsePolicy(strict, 'header', false), parsePolicy("img-src 'self'", 'header', true)]);
    expect(v.allowed).toBe(true);
    expect(v.unrestricted).toBe(true);
  });
});

describe('inlineHashConflict and hasHashSources', () => {
  it('flags unsafe-inline next to a hash or nonce', () => {
    const p = parsePolicy("script-src 'self' 'unsafe-inline' 'sha256-abc'", 'header', true);
    expect(inlineHashConflict([p])).toHaveLength(1);
    expect(hasHashSources([p])).toBe(true);
    expect(inlineHashConflict([parsePolicy("script-src 'self' 'nonce-x' 'unsafe-inline'", 'header', true)])).toHaveLength(1);
    expect(inlineHashConflict([parsePolicy(strict, 'header', true)])).toHaveLength(0);
    expect(hasHashSources([parsePolicy(strict, 'header', true)])).toBe(false);
  });
});

describe('isSecureContextUrl', () => {
  it('accepts https and loopback hosts, rejects plain http elsewhere', () => {
    expect(isSecureContextUrl(new URL('https://commitproof.com/'))).toBe(true);
    expect(isSecureContextUrl(new URL('http://localhost:4173/strict/'))).toBe(true);
    expect(isSecureContextUrl(new URL('http://127.0.0.1/'))).toBe(true);
    expect(isSecureContextUrl(new URL('http://app.localhost/'))).toBe(true);
    expect(isSecureContextUrl(new URL('http://example.com/'))).toBe(false);
  });

  it('accepts the whole loopback block and a trailing-dot hostname', () => {
    expect(isSecureContextUrl(new URL('http://127.0.0.2:8080/'))).toBe(true);
    expect(isSecureContextUrl(new URL('http://localhost./'))).toBe(true);
  });
});

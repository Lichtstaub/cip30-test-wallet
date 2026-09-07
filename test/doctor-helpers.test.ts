import { describe, expect, it } from 'vitest';
import { parsePolicy, type Policy } from '../src/checks/csp.js';
import { pickProbeTarget, resolveRouteProbe } from '../src/host/doctor.js';
import type { ObservedState } from '../src/host/doctor-probes.js';

const ORIGIN = 'https://example.com';

function state(overrides: Partial<ObservedState> = {}): ObservedState {
  return {
    firstAccessMs: null,
    count: 0,
    lastAccessMs: null,
    violations: [],
    routeProbeEval: null,
    routeProbeError: null,
    injectedAtMs: null,
    countAfterInjection: 0,
    ...overrides,
  };
}

describe('pickProbeTarget', () => {
  it('skips when an enforced policy pins scripts by hash', () => {
    const policies: Policy[] = [parsePolicy("script-src 'sha256-abc123'", 'header', true)];
    const scripts = [{ src: `${ORIGIN}/a.js`, integrity: null }];
    expect(pickProbeTarget(policies, scripts, ORIGIN)).toEqual({
      target: null,
      reason: 'script-src pins scripts by hash, appending a probe would break the page',
    });
  });

  it('skips when there is no external first-party script', () => {
    const scripts = [{ src: 'https://cdn.other.example/a.js', integrity: null }];
    expect(pickProbeTarget([], scripts, ORIGIN)).toEqual({
      target: null,
      reason: 'no external first-party script to append the probe to',
    });
  });

  it('skips when every first-party script carries an integrity attribute', () => {
    const scripts = [
      { src: `${ORIGIN}/a.js`, integrity: 'sha256-aaa' },
      { src: `${ORIGIN}/b.js`, integrity: 'sha256-bbb' },
    ];
    expect(pickProbeTarget([], scripts, ORIGIN)).toEqual({
      target: null,
      reason: 'every first-party script carries an integrity attribute',
    });
  });

  it('picks the first first-party script without an integrity attribute', () => {
    const scripts = [
      { src: `${ORIGIN}/a.js`, integrity: 'sha256-aaa' },
      { src: `${ORIGIN}/b.js`, integrity: null },
      { src: `${ORIGIN}/c.js`, integrity: null },
      { src: 'https://cdn.other.example/d.js', integrity: null },
    ];
    expect(pickProbeTarget([], scripts, ORIGIN)).toEqual({ target: `${ORIGIN}/b.js`, reason: null });
  });
});

describe('resolveRouteProbe', () => {
  it('skips with no reason when no target was picked', () => {
    expect(resolveRouteProbe(null, false, state())).toEqual({ routeProbe: 'skipped', routeProbeReason: null });
  });

  it('skips with a reason when the interception never matched the script url', () => {
    expect(resolveRouteProbe(`${ORIGIN}/a.js`, false, state())).toEqual({
      routeProbe: 'skipped',
      routeProbeReason: 'our interception never matched the script url',
    });
  });

  it('skips with a reason when the script was intercepted but the probe did not execute', () => {
    expect(resolveRouteProbe(`${ORIGIN}/a.js`, true, state({ routeProbeEval: null }))).toEqual({
      routeProbe: 'skipped',
      routeProbeReason: 'the script was intercepted but the probe did not execute',
    });
  });

  it('reports an error with the recorded message', () => {
    expect(resolveRouteProbe(`${ORIGIN}/a.js`, true, state({ routeProbeEval: 'error', routeProbeError: 'boom' }))).toEqual({
      routeProbe: 'error',
      routeProbeReason: 'boom',
    });
  });

  it('passes ok through with no reason', () => {
    expect(resolveRouteProbe(`${ORIGIN}/a.js`, true, state({ routeProbeEval: 'ok' }))).toEqual({ routeProbe: 'ok', routeProbeReason: null });
  });

  it('passes blocked through with no reason', () => {
    expect(resolveRouteProbe(`${ORIGIN}/a.js`, true, state({ routeProbeEval: 'blocked' }))).toEqual({ routeProbe: 'blocked', routeProbeReason: null });
  });
});

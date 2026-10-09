import { ChwError } from '../../core/errors.js';
import { parseJsonBig } from './json.js';

// What the Ogmios and Koios clients share on the wire: the timeout, the
// redaction of secrets, and how a failed request becomes a message.

/** How long one request may take before it counts as a transport failure. */
export const CHAIN_TIMEOUT_MS = 30_000;

/** The text with every secret replaced by <redacted>. The one place a secret leaves a message. */
export function redact(text: string, secrets: readonly string[]): string {
  return secrets.reduce((out, secret) => (secret === '' ? out : out.split(secret).join('<redacted>')), text);
}

/** Every string of a JSON value redacted, keys included, for a JSON-RPC error that goes back to the caller. */
export function scrub(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return redact(value, secrets);
  if (Array.isArray(value)) return value.map((item) => scrub(item, secrets));
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key, secrets), scrub(item, secrets)]));
  return value;
}

/** The ChwError for a provider that did not answer usably: '<provider> <method> failed: <reason>', never a URL or a header, every secret redacted. */
export function chainUnavailable(provider: string, method: string, reason: string, secrets: readonly string[] = []): ChwError {
  return new ChwError('CHW_CHAIN_UNAVAILABLE', redact(`${provider} ${method} failed: ${reason}`, secrets));
}

/** Why a fetch rejected, for chainUnavailable: a timeout, or the error code Node's fetch keeps in cause. Never a message, one can name the host or a header value. */
export function fetchFailure(error: unknown): string {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return `no answer within ${CHAIN_TIMEOUT_MS / 1000} s`;
  // Node's fetch rejects with "fetch failed" and keeps the reason (ECONNREFUSED and the like) in cause.code.
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  const code = typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? `request failed: ${code}` : 'request failed';
}

/**
 * One request with the timeout, its status and body text. init is built inside the guard, so a body
 * that does not serialize fails like the request. Anything thrown becomes fail with the reason fetchFailure gives.
 */
export async function fetchText(doFetch: typeof fetch, url: string, init: () => RequestInit, fail: (reason: string) => Error): Promise<{ status: number; text: string }> {
  try {
    const response = await doFetch(url, { ...init(), signal: AbortSignal.timeout(CHAIN_TIMEOUT_MS) });
    return { status: response.status, text: await response.text() };
  } catch (error) {
    throw fail(fetchFailure(error));
  }
}

/** The body read with parseJsonBig. A body that is not JSON throws fail naming the status. */
export function jsonBody(status: number, text: string, fail: (reason: string) => Error): unknown {
  try {
    return parseJsonBig(text);
  } catch {
    throw fail(`HTTP ${status} with a body that is not JSON`);
  }
}

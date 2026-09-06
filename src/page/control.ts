import { apiError, APIErrorCode, TxSignErrorCode, txSignError } from '../core/errors.js';
import { INSTALL_TIME_QUIRKS, QUIRK_NAMES, type HangableMethod, type JournalEntry, type QuirkConfig, type QuirkName } from './config.js';

interface Deferred {
  resolve: () => void;
  reject: (e: unknown) => void;
}

/**
 * The test's handle inside the page: the journal of every CIP-30 call, the
 * live quirk switches, and the deferreds behind hanging calls. Exposed as
 * window.__chw so any runner can reach it with its own evaluate.
 */
export class Control {
  readonly journal: JournalEntry[] = [];
  readonly quirks: QuirkConfig;
  private readonly pending = new Map<HangableMethod, Deferred[]>();

  constructor(quirks: QuirkConfig) {
    this.quirks = { ...quirks };
  }

  setQuirk<K extends QuirkName>(name: K, value: QuirkConfig[K]): void {
    if (!(QUIRK_NAMES as readonly string[]).includes(name)) {
      throw apiError(APIErrorCode.InvalidRequest, `unknown quirk "${name}", known quirks: ${QUIRK_NAMES.join(', ')}`);
    }
    if ((INSTALL_TIME_QUIRKS as readonly string[]).includes(name)) {
      throw apiError(APIErrorCode.InvalidRequest, `${name} only applies at install time, set it in walletOptions.quirks`);
    }
    this.quirks[name] = value;
  }

  /** Blocks until release or reject is called for the method. */
  wait(method: HangableMethod): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const list = this.pending.get(method) ?? [];
      list.push({ resolve, reject });
      this.pending.set(method, list);
    });
  }

  /** Lets every hanging call of the method continue. Returns how many it settled. */
  release(method: HangableMethod): number {
    const list = this.take(method);
    for (const d of list) d.resolve();
    return list.length;
  }

  /** Fails every hanging call of the method the way a user cancelling would. Returns how many it settled. */
  reject(method: HangableMethod): number {
    const list = this.take(method);
    for (const d of list) d.reject(txSignError(TxSignErrorCode.UserDeclined, 'user declined to sign the transaction'));
    return list.length;
  }

  /** Runs fn and journals method, arguments (trailing undefined entries trimmed), result or error. */
  async record<T>(method: string, args: unknown[], fn: () => Promise<T>): Promise<T> {
    const trimmedArgs = args.slice();
    while (trimmedArgs.length > 0 && trimmedArgs[trimmedArgs.length - 1] === undefined) trimmedArgs.pop();
    const entry: JournalEntry = { method, args: trimmedArgs, t: Date.now() };
    this.journal.push(entry);
    try {
      const result = await fn();
      entry.result = journalValue(result);
      return result;
    } catch (e) {
      entry.error = e instanceof Error ? { name: e.name, message: e.message } : e;
      throw e;
    }
  }

  private take(method: HangableMethod): Deferred[] {
    const list = this.pending.get(method) ?? [];
    this.pending.delete(method);
    return list;
  }
}

/** Objects with functions (the api object returned by enable) are journaled as a marker. */
function journalValue(v: unknown): unknown {
  if (v !== null && typeof v === 'object' && Object.values(v as object).some((x) => typeof x === 'function')) return '[api]';
  return v;
}

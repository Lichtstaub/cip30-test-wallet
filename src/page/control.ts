import { TxSignErrorCode, txSignError } from '../core/errors.js';
import type { HangableMethod, JournalEntry, QuirkConfig, QuirkName } from './config.js';

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

  /** Lets every hanging call of the method continue. */
  release(method: HangableMethod): void {
    for (const d of this.take(method)) d.resolve();
  }

  /** Fails every hanging call of the method the way a user cancelling would. */
  reject(method: HangableMethod): void {
    for (const d of this.take(method)) d.reject(txSignError(TxSignErrorCode.UserDeclined, 'user declined to sign the transaction'));
  }

  /** Runs fn and journals method, arguments, result or error. */
  async record<T>(method: string, args: unknown[], fn: () => Promise<T>): Promise<T> {
    const entry: JournalEntry = { method, args, t: Date.now() };
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

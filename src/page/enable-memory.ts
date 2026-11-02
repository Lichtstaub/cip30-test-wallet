import { askBinding, type LedgerBinding } from './binding-ledger.js';

/**
 * Where the wallet remembers a successful enable() per origin, with
 * rememberEnable only. An opaque origin, the string 'null', is never added.
 */
export interface EnableMemory {
  has(origin: string): Promise<boolean>;
  add(origin: string): Promise<void>;
  forget(origin: string): Promise<void>;
}

/** The origin of a sandboxed iframe, about:blank or a data: URL. Nothing is remembered for it. */
export const OPAQUE_ORIGIN = 'null';

/** The grants in Node, one set per wallet handle behind the ledger binding. The page cannot clear them. */
export function bindingEnableMemory(call: LedgerBinding): EnableMemory {
  return {
    has: async (origin) => (await askBinding(call, 'enableHas', origin)) === true,
    add: async (origin) => {
      if (origin !== OPAQUE_ORIGIN) await askBinding(call, 'enableAdd', origin);
    },
    forget: async (origin) => {
      await askBinding(call, 'enableForget', origin);
    },
  };
}

/**
 * The grant in the page's sessionStorage, for the init script without a host. The key
 * __chw:enabled:<name> holds the origin that enabled the wallet. Storage is per origin
 * anyway, the value guards against a storage shared across origins. Every access may
 * throw (blocked storage, sandboxed frames), a failure means not remembered.
 */
export function sessionEnableMemory(storage: () => Storage | undefined, name: string): EnableMemory {
  const key = `__chw:enabled:${name}`;
  return {
    has: async (origin) => {
      try {
        return origin !== OPAQUE_ORIGIN && storage()?.getItem(key) === origin;
      } catch {
        return false;
      }
    },
    add: async (origin) => {
      if (origin === OPAQUE_ORIGIN) return;
      try {
        storage()?.setItem(key, origin);
      } catch {
        // Not remembered, the wallet works as without the option.
      }
    },
    forget: async () => {
      try {
        storage()?.removeItem(key);
      } catch {
        // Nothing stored that could be read back.
      }
    },
  };
}

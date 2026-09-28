// BIP32-Ed25519 against two independent implementations: CSL (Rust compiled
// to WASM) and Evolution (TypeScript). Inputs come from a seeded generator, so
// every run checks the same few hundred cases and a failure is reproducible.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { Bip32PrivateKey as EvoBip32 } from '@evolution-sdk/evolution';
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { describe, expect, it } from 'vitest';
import { bytesToHex } from '../src/core/bytes.js';
import { publicKey } from '../src/core/keys.js';
import { HARDENED, deriveChild, derivePath, publicKeyOf, rootKey } from '../src/derive/bip32.js';
import { deriveAccount } from '../src/derive/index.js';
import { prepareWallet } from '../src/host/config.js';
import { cslDerive } from './helpers/csl.js';
import { MNEMONIC } from './fixtures/vectors.js';

// mulberry32, enough to spread inputs, not meant to be cryptographic.
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const bytes = (n: number) => Uint8Array.from({ length: n }, () => Math.floor(next() * 256));
  const uint32 = () => Math.floor(next() * 0x100000000);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]!;
  return { next, bytes, uint32, pick };
}

const ENTROPY_LENGTHS = [16, 20, 24, 28, 32] as const; // 12, 15, 18, 21, 24 words

// Indices at both ends of the soft and hardened ranges plus random ones.
const EDGE_INDICES = [0, 1, 2, 3, HARDENED - 1, HARDENED, HARDENED + 1, HARDENED + 1852, 0xffffffff];
function randomIndex(r: ReturnType<typeof rng>): number {
  const bucket = r.next();
  if (bucket < 0.3) return r.pick(EDGE_INDICES);
  if (bucket < 0.65) return r.uint32() % HARDENED;
  return HARDENED + (r.uint32() % HARDENED);
}

function entropies(): Uint8Array[] {
  const r = rng(0xc1b30);
  const out: Uint8Array[] = [];
  for (const len of ENTROPY_LENGTHS) {
    out.push(new Uint8Array(len), new Uint8Array(len).fill(0xff));
    for (let i = 0; i < 6; i++) out.push(r.bytes(len));
  }
  return out;
}

const cslRoot = (entropy: Uint8Array, password = new Uint8Array()) =>
  CSL.Bip32PrivateKey.from_bip39_entropy(entropy, password);

describe('rootKey, the Icarus master key', () => {
  for (const entropy of entropies()) {
    it(`matches CSL for ${entropy.length} bytes of entropy ${bytesToHex(entropy).slice(0, 12)}`, () => {
      const ours = rootKey(entropy);
      expect(bytesToHex(ours)).toBe(bytesToHex(cslRoot(entropy).as_bytes()));
      // Clamp on kL: low three bits clear, bits 255 and 253 clear, bit 254 set.
      expect(ours[0]! & 0b111).toBe(0);
      expect(ours[31]! & 0b1110_0000).toBe(0b0100_0000);
    });
  }

  it('matches CSL with a passphrase', () => {
    const r = rng(7);
    for (const passphrase of ['', 'a', 'correct horse battery staple', 'ünïcødé ✓']) {
      const entropy = r.bytes(32);
      const pw = new TextEncoder().encode(passphrase);
      expect(bytesToHex(rootKey(entropy, pw))).toBe(bytesToHex(cslRoot(entropy, pw).as_bytes()));
    }
  });

  it('matches CSL with binary passphrases around the HMAC block size', () => {
    // SHA-512 hashes an HMAC key longer than 128 bytes first, so 128 and 129
    // take different paths. Every byte value 0 to 255 appears.
    const entropy = new Uint8Array(16);
    for (const len of [127, 128, 129, 256]) {
      const pw = Uint8Array.from({ length: len }, (_, i) => i % 256);
      expect(bytesToHex(rootKey(entropy, pw))).toBe(bytesToHex(cslRoot(entropy, pw).as_bytes()));
    }
  });

  it('matches Evolution', () => {
    for (const entropy of entropies().slice(0, 10)) {
      expect(bytesToHex(rootKey(entropy))).toBe(bytesToHex(EvoBip32.toBytes(EvoBip32.fromBip39Entropy(entropy))));
    }
  });
});

describe('deriveChild', () => {
  // Random walks from random roots, every step compared in full: kL, kR,
  // chain code and the public key.
  const r = rng(0x1852);
  const walks = Array.from({ length: 40 }, (_, i) => ({
    entropy: r.bytes(ENTROPY_LENGTHS[i % ENTROPY_LENGTHS.length]!),
    path: Array.from({ length: 1 + (r.uint32() % 8) }, () => randomIndex(r)),
  }));

  for (const [n, { entropy, path }] of walks.entries()) {
    it(`walk ${n} matches CSL at every step (${path.map((i) => (i >= HARDENED ? `${i - HARDENED}'` : `${i}`)).join('/')})`, () => {
      let ours = rootKey(entropy);
      let theirs = cslRoot(entropy);
      for (const index of path) {
        ours = deriveChild(ours, index);
        theirs = theirs.derive(index);
        expect(bytesToHex(ours)).toBe(bytesToHex(theirs.as_bytes()));
        expect(bytesToHex(publicKeyOf(ours))).toBe(bytesToHex(theirs.to_raw_key().to_public().as_bytes()));
      }
    });
  }

  it('matches Evolution on the same walks', () => {
    for (const { entropy, path } of walks.slice(0, 15)) {
      const evo = EvoBip32.derive(EvoBip32.fromBip39Entropy(entropy), path);
      expect(bytesToHex(derivePath(rootKey(entropy), path))).toBe(bytesToHex(EvoBip32.toBytes(evo)));
    }
  });

  it('gives the same soft child public key as public derivation in CSL', () => {
    // Soft derivation must depend on the parent's public key only. CSL derives
    // the child from a Bip32PublicKey here, which never sees kL or kR.
    const r2 = rng(3);
    for (let i = 0; i < 20; i++) {
      const entropy = r2.bytes(32);
      const parentPath = [HARDENED + 1852, HARDENED + 1815, HARDENED + (r2.uint32() % HARDENED)];
      const index = i < 4 ? [0, 1, 2, HARDENED - 1][i]! : r2.uint32() % HARDENED;
      let cslParent = cslRoot(entropy);
      for (const p of parentPath) cslParent = cslParent.derive(p);
      const cslChildPub = cslParent.to_public().derive(index);
      const ours = deriveChild(derivePath(rootKey(entropy), parentPath), index);
      expect(bytesToHex(publicKeyOf(ours))).toBe(bytesToHex(cslChildPub.to_raw_key().as_bytes()));
      expect(bytesToHex(ours.subarray(64))).toBe(bytesToHex(cslChildPub.chaincode()));
    }
  });

  it('keeps matching CSL on a 64 step hardened chain, where kL grows the most', () => {
    const entropy = new Uint8Array(32).fill(0xff);
    let ours = rootKey(entropy);
    let theirs = cslRoot(entropy);
    for (let i = 0; i < 64; i++) {
      ours = deriveChild(ours, 0xffffffff);
      theirs = theirs.derive(0xffffffff);
    }
    expect(bytesToHex(ours)).toBe(bytesToHex(theirs.as_bytes()));
  });

  it('carries through every upper byte of kL and wraps kR like CSL', () => {
    // kL = f8 ff..ff 5f is the largest clamped scalar, so 8 * zL carries
    // through bytes 28 to 31. kR = ff..ff overflows on any nonzero zR.
    const parent = rootKey(new Uint8Array(16));
    parent.set([0xf8, ...new Array(30).fill(0xff), 0x5f], 0);
    parent.fill(0xff, 32, 64);
    const cslParent = CSL.Bip32PrivateKey.from_bytes(parent);
    for (const index of [0, 1, HARDENED - 1, HARDENED, 0xffffffff]) {
      expect(bytesToHex(deriveChild(parent, index))).toBe(bytesToHex(cslParent.derive(index).as_bytes()));
    }
  });

  it('reads a parent at a nonzero offset and returns independent children', () => {
    const r2 = rng(11);
    const buffer = new Uint8Array(160);
    const root = rootKey(r2.bytes(24));
    buffer.set(root, 17);
    const view = buffer.subarray(17, 17 + 96);
    const reference = CSL.Bip32PrivateKey.from_bytes(root);
    const soft = deriveChild(view, 5);
    const hard = deriveChild(view, HARDENED + 5);
    expect(bytesToHex(soft)).toBe(bytesToHex(reference.derive(5).as_bytes()));
    expect(bytesToHex(hard)).toBe(bytesToHex(reference.derive(HARDENED + 5).as_bytes()));
    soft.fill(0);
    hard.fill(0);
    expect(bytesToHex(view)).toBe(bytesToHex(root));
    expect(bytesToHex(deriveChild(view, 5))).toBe(bytesToHex(reference.derive(5).as_bytes()));
    const copy = derivePath(view, []);
    copy.fill(0);
    expect(bytesToHex(view)).toBe(bytesToHex(root));
  });

  it('rejects indices outside 0 to 2^32 - 1', () => {
    const parent = rootKey(new Uint8Array(16));
    for (const bad of [-1, 0.5, 0x100000000, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => deriveChild(parent, bad)).toThrow(/derivation index/);
    }
  });

  it('rejects a parent that is not 96 bytes', () => {
    expect(() => deriveChild(new Uint8Array(64), 0)).toThrow(/96 bytes/);
  });
});

describe('deriveAccount against CSL', () => {
  const r = rng(0xdeb);
  const mnemonics = [MNEMONIC, ...ENTROPY_LENGTHS.map((len) => entropyToMnemonic(r.bytes(len), wordlist))];
  const accounts = [0, 1, 2, 255, 256, HARDENED - 1];

  for (const mnemonic of mnemonics) {
    for (const accountIndex of accounts) {
      it(`${mnemonic.split(' ').length} words, account ${accountIndex}`, () => {
        const ours = deriveAccount(mnemonic, accountIndex);
        const ref = cslDerive(mnemonic, 0, accountIndex);
        expect(bytesToHex(ours.payment.bytes)).toBe(bytesToHex(ref.paymentExtended));
        expect(bytesToHex(ours.stake.bytes)).toBe(bytesToHex(ref.stakeExtended));
        expect(bytesToHex(ours.drep.bytes)).toBe(bytesToHex(ref.drepExtended));
        expect(bytesToHex(publicKey(ours.payment))).toBe(bytesToHex(ref.paymentPub));
        expect(bytesToHex(publicKey(ours.stake))).toBe(bytesToHex(ref.stakePub));
        expect(bytesToHex(publicKey(ours.drep))).toBe(bytesToHex(ref.drepPub));
      });
    }
  }

  it('returns 64 byte extended keys without the chain code', () => {
    const { payment, stake, drep } = deriveAccount(MNEMONIC);
    for (const key of [payment, stake, drep]) {
      expect(key.kind).toBe('extended');
      expect(key.bytes.length).toBe(64);
    }
  });

  it('rejects an account index outside 0 to 2^31 - 1', () => {
    for (const bad of [-1, 0.5, HARDENED, Number.NaN]) {
      expect(() => deriveAccount(MNEMONIC, bad)).toThrow(/accountIndex/);
      expect(() => prepareWallet({ accountIndex: bad })).toThrow(/accountIndex/);
    }
  });

  it('rejects a mnemonic with a bad checksum or an unknown word', () => {
    expect(() => deriveAccount(MNEMONIC.replace(/choice$/, 'abandon'))).toThrow(/invalid mnemonic/);
    expect(() => deriveAccount(MNEMONIC.replace(/^test/, 'tesst'))).toThrow(/invalid mnemonic/);
  });
});

describe('runtime dependencies', () => {
  const root = join(import.meta.dirname, '..');

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
    });
  }

  it('ships without Evolution: only tests import it', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(Object.keys(pkg.dependencies)).not.toContain('@evolution-sdk/evolution');
    const importers = sourceFiles(join(root, 'src')).filter((f) => readFileSync(f, 'utf8').includes('@evolution-sdk/'));
    expect(importers).toEqual([]);
  });
});

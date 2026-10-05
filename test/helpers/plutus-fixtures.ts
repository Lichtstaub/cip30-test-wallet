import { readFileSync } from 'node:fs';
import { hexToBytes } from '../../src/core/bytes.js';

// Real compiled Plutus scripts from test/fixtures/plutus/scripts.json, see the
// README there for where each one comes from and how to rebuild them.

export const PLUTUS_FIXTURE_NAMES = [
  'v3_always_succeeds',
  'v3_always_fails',
  'v3_always_fails_traced',
  'v3_needs_signer',
  'v3_after_deadline',
  'v3_burn',
  'v3_two_args',
  'v2_always_succeeds',
  'v1_always_succeeds',
] as const;

export type PlutusFixtureName = (typeof PLUTUS_FIXTURE_NAMES)[number];

const LANGUAGES = { PlutusV1: 1, PlutusV2: 2, PlutusV3: 3 } as const;

export interface PlutusFixture {
  name: PlutusFixtureName;
  /** The tag the ledger hashes with: 1 to 3 for Plutus V1 to V3. */
  language: 1 | 2 | 3;
  /** The hash the file records, never recomputed here, so a test can check it against the bytes. */
  hash: Uint8Array;
  hashHex: string;
  /** The script as the witness set and a blueprint's compiledCode carry it: a CBOR byte string around the flat program. */
  cborHex: string;
  bytes: Uint8Array;
  origin: string;
}

interface FixtureEntry {
  name: string;
  language: keyof typeof LANGUAGES;
  hash: string;
  cborHex: string;
  origin: string;
}

const entries = JSON.parse(readFileSync(new URL('../fixtures/plutus/scripts.json', import.meta.url), 'utf8')) as FixtureEntry[];

function toFixture(entry: FixtureEntry): PlutusFixture {
  if (!(PLUTUS_FIXTURE_NAMES as readonly string[]).includes(entry.name)) throw new Error(`unknown Plutus fixture ${entry.name}`);
  if (!Object.hasOwn(LANGUAGES, entry.language)) throw new Error(`Plutus fixture ${entry.name} has unknown language ${entry.language}`);
  return {
    name: entry.name as PlutusFixtureName,
    language: LANGUAGES[entry.language],
    hash: hexToBytes(entry.hash),
    hashHex: entry.hash,
    cborHex: entry.cborHex,
    bytes: hexToBytes(entry.cborHex),
    origin: entry.origin,
  };
}

const fixtures = entries.map(toFixture);

/** Every fixture in file order. */
export function plutusFixtures(): PlutusFixture[] {
  return fixtures.map((f) => ({ ...f, hash: f.hash.slice(), bytes: f.bytes.slice() }));
}

/** One fixture by name, with its own copies of hash and bytes. */
export function plutusScript(name: PlutusFixtureName): PlutusFixture {
  const found = fixtures.find((f) => f.name === name);
  if (!found) throw new Error(`Plutus fixture ${name} is missing from scripts.json`);
  return { ...found, hash: found.hash.slice(), bytes: found.bytes.slice() };
}

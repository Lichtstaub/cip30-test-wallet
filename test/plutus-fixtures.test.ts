import { readFileSync } from 'node:fs';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '../src/core/bytes.js';
import { decode } from '../src/core/cbor/decode.js';
import { scriptHash } from '../src/core/scripts.js';
import { PLUTUS_FIXTURE_NAMES, plutusFixtures, plutusScript } from './helpers/plutus-fixtures.js';
import { PLUTUS_V3, PLUTUS_V3_TWO_ARGS } from './helpers/synthetic.js';

const cslPlutus = { 1: CSL.PlutusScript.new, 2: CSL.PlutusScript.new_v2, 3: CSL.PlutusScript.new_v3 } as const;

describe('Plutus fixtures', () => {
  it('scripts.json holds every named fixture exactly once', () => {
    expect(plutusFixtures().map((f) => f.name)).toEqual([...PLUTUS_FIXTURE_NAMES]);
  });

  it.each(PLUTUS_FIXTURE_NAMES)('%s: the recorded hash is blake2b-224 over the language tag and the bytes, like CSL', (name) => {
    const f = plutusScript(name);
    expect(bytesToHex(scriptHash(f.language, f.bytes))).toBe(f.hashHex);
    expect(cslPlutus[f.language](f.bytes).hash().to_hex()).toBe(f.hashHex);
  });

  it.each(PLUTUS_FIXTURE_NAMES)('%s: the bytes are one CBOR byte string around the flat program, the form the witness set carries', (name) => {
    expect(decode(plutusScript(name).bytes)).toBeInstanceOf(Uint8Array);
  });

  it('the V1 and V2 always succeeds share their bytes, the language tag alone changes the hash', () => {
    const [v1, v2] = [plutusScript('v1_always_succeeds'), plutusScript('v2_always_succeeds')];
    expect(v1.cborHex).toBe(v2.cborHex);
    expect(v1.hashHex).not.toBe(v2.hashHex);
  });

  it('the traced always fails carries its trace text, the plain one does not', () => {
    const [plain, traced] = [plutusScript('v3_always_fails'), plutusScript('v3_always_fails_traced')];
    expect(traced.language).toBe(plain.language);
    expect(traced.hashHex).not.toBe(plain.hashHex);
    // The trace text is in the program as a constant.
    expect(new TextDecoder('latin1').decode(traced.bytes)).toContain('oracle: always fails');
    expect(new TextDecoder('latin1').decode(plain.bytes)).not.toContain('oracle: always fails');
  });

  it('oracle.ak defines every aiken validator the fixtures name', () => {
    const source = readFileSync('test/fixtures/plutus/oracle.ak', 'utf8');
    for (const validator of ['always_succeeds', 'always_fails', 'needs_signer', 'after_deadline', 'burn']) expect(source).toContain(`validator ${validator} {`);
  });

  it('PLUTUS_V3 is the aiken always succeeds, PLUTUS_V3_TWO_ARGS the bare two argument program', () => {
    expect(bytesToHex(scriptHash(3, hexToBytes(PLUTUS_V3)))).toBe('5d0f747d4eb70739ff667eed99b934de3a3e5054fae1e368902078e3');
    expect(PLUTUS_V3_TWO_ARGS).toBe('4601000022499d');
  });

  it('hands out copies, a test cannot change the bytes another one reads', () => {
    plutusScript('v3_always_succeeds').bytes.fill(0);
    plutusFixtures()[0]!.hash.fill(0);
    expect(bytesToHex(scriptHash(3, plutusScript('v3_always_succeeds').bytes))).toBe(plutusScript('v3_always_succeeds').hashHex);
    expect(bytesToHex(plutusScript('v3_always_succeeds').hash)).toBe(plutusScript('v3_always_succeeds').hashHex);
  });
});

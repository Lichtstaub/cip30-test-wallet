import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FIXTURE_TX_HASH } from './fixtures/vectors.js';

describe('fixture', () => {
  it('is a 4-element CBOR array with the expected size', () => {
    const hex = readFileSync('test/fixtures/preprod-0a399be6.hex', 'utf8').trim();
    expect(hex.slice(0, 2)).toBe('84');
    expect(hex.length / 2).toBe(1695);
    expect(FIXTURE_TX_HASH).toHaveLength(64);
  });
});

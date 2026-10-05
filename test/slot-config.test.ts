import { describe, expect, it } from 'vitest';
import { SLOT_CONFIG_NETWORK } from '@evolution-sdk/evolution/SlotConfig';
import { defaultNetwork, SLOT_CONFIGS, type CardanoNetwork } from '../src/host/slot-config.js';

/** POSIX ms at the start of a slot, the formula the ledger's epoch info applies after the Byron era. */
const posixMs = (network: CardanoNetwork, slot: bigint) => {
  const { zeroTime, zeroSlot, slotLength } = SLOT_CONFIGS[network];
  return zeroTime + (slot - zeroSlot) * slotLength;
};

describe('slot calendars', () => {
  it.each([
    ['mainnet', 'epoch 208, the first Shelley epoch', 4_492_800n, 1_596_059_091n],
    ['preprod', 'epoch 4, the first Shelley epoch', 86_400n, 1_655_769_600n],
    ['preview', 'epoch 0', 0n, 1_666_656_000n],
  ] as const)('%s: %s starts at slot %s, POSIX %s', (network, _epoch, slot, seconds) => {
    expect(posixMs(network, slot)).toBe(seconds * 1000n);
  });

  it('agree with the calendars Evolution SDK ships', () => {
    const evolution = { mainnet: SLOT_CONFIG_NETWORK.Mainnet, preprod: SLOT_CONFIG_NETWORK.Preprod, preview: SLOT_CONFIG_NETWORK.Preview };
    for (const network of ['mainnet', 'preprod', 'preview'] as const) {
      const { zeroTime, zeroSlot, slotLength } = evolution[network];
      expect(SLOT_CONFIGS[network]).toEqual({ zeroTime, zeroSlot, slotLength: BigInt(slotLength) });
    }
  });

  it('cover exactly the three public networks and cannot be changed', () => {
    expect(Object.keys(SLOT_CONFIGS).sort()).toEqual(['mainnet', 'preprod', 'preview']);
    expect(Object.isFrozen(SLOT_CONFIGS)).toBe(true);
    expect(Object.isFrozen(SLOT_CONFIGS.preprod)).toBe(true);
  });

  it('networkId 0 stands for preprod and 1 for mainnet', () => {
    expect(defaultNetwork(0)).toBe('preprod');
    expect(defaultNetwork(1)).toBe('mainnet');
  });
});

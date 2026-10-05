// Node side. The slot calendar of each public network: the POSIX time of a
// slot is zeroTime + (slot - zeroSlot) * slotLength, in milliseconds. Plutus
// scripts see the validity interval in these times. Byron slots before
// zeroSlot have another length, transactions of today never reach them.

export type CardanoNetwork = 'mainnet' | 'preprod' | 'preview';

/** zeroTime and slotLength in ms, zeroSlot the first slot from which every slot lasts slotLength. */
export interface SlotConfig {
  zeroTime: bigint;
  zeroSlot: bigint;
  slotLength: bigint;
}

// The first Shelley slot and its time from the network's genesis files,
// checked against Koios epoch_info: mainnet epoch 208 starts at slot 4492800
// (1596059091), preprod epoch 4 at slot 86400 (1655769600), preview counts
// every slot at one second from slot 0 (1666656000).
export const SLOT_CONFIGS: Readonly<Record<CardanoNetwork, SlotConfig>> = Object.freeze({
  mainnet: Object.freeze({ zeroTime: 1_596_059_091_000n, zeroSlot: 4_492_800n, slotLength: 1_000n }),
  preprod: Object.freeze({ zeroTime: 1_655_769_600_000n, zeroSlot: 86_400n, slotLength: 1_000n }),
  preview: Object.freeze({ zeroTime: 1_666_656_000_000n, zeroSlot: 0n, slotLength: 1_000n }),
});

/** The network a networkId stands for when ledger.network is left out: 0 preprod, 1 mainnet. */
export function defaultNetwork(networkId: 0 | 1): CardanoNetwork {
  return networkId === 1 ? 'mainnet' : 'preprod';
}

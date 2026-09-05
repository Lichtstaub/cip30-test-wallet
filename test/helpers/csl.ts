// Independent reference implementation. CSL is a different codebase (Rust
// compiled to WASM), so agreement with it is not agreement with ourselves.
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

const harden = (n: number) => 0x80000000 + n;

export function cslDerive(mnemonic: string, networkId = 0) {
  const entropy = mnemonicToEntropy(mnemonic, wordlist);
  const root = CSL.Bip32PrivateKey.from_bip39_entropy(entropy, new Uint8Array());
  const account = root.derive(harden(1852)).derive(harden(1815)).derive(harden(0));
  const payment = account.derive(0).derive(0).to_raw_key();
  const stake = account.derive(2).derive(0).to_raw_key();
  const paymentCred = CSL.Credential.from_keyhash(payment.to_public().hash());
  const stakeCred = CSL.Credential.from_keyhash(stake.to_public().hash());
  return {
    paymentExtended: payment.as_bytes(),
    stakeExtended: stake.as_bytes(),
    paymentPub: payment.to_public().as_bytes(),
    stakePub: stake.to_public().as_bytes(),
    paymentAddress: CSL.BaseAddress.new(networkId, paymentCred, stakeCred).to_address().to_bech32(),
    rewardAddress: CSL.RewardAddress.new(networkId, stakeCred).to_address().to_bech32(),
    signHello: payment.sign(new TextEncoder().encode('hello')).to_bytes(),
    signWith: (message: Uint8Array) => payment.sign(message).to_bytes(),
  };
}

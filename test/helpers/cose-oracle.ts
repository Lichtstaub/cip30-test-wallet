// Independent COSE implementation. Emurgo's message-signing library is Rust
// compiled to WASM, the same code many wallets used for CIP-8, so byte
// equality with it is agreement with the ecosystem, not with ourselves.
import MS from '@emurgo/cardano-message-signing-nodejs';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';

/** COSE_Sign1 and COSE_Key built by the reference library for a 64-byte extended key. */
export function oracleSign(extendedKey: Uint8Array, address: Uint8Array, payload: Uint8Array): { signature: Uint8Array; key: Uint8Array } {
  const priv = CSL.PrivateKey.from_extended_bytes(extendedKey);
  const protectedMap = MS.HeaderMap.new();
  protectedMap.set_algorithm_id(MS.Label.from_algorithm_id(MS.AlgorithmId.EdDSA));
  protectedMap.set_header(MS.Label.new_text('address'), MS.CBORValue.new_bytes(address));
  const headers = MS.Headers.new(MS.ProtectedHeaderMap.new(protectedMap), MS.HeaderMap.new());
  const builder = MS.COSESign1Builder.new(headers, payload, false);
  const signature = priv.sign(builder.make_data_to_sign().to_bytes()).to_bytes();
  const sign1 = builder.build(signature);
  const key = MS.COSEKey.new(MS.Label.from_key_type(MS.KeyType.OKP));
  key.set_algorithm_id(MS.Label.from_algorithm_id(MS.AlgorithmId.EdDSA));
  key.set_header(MS.Label.new_int(MS.Int.new_negative(MS.BigNum.from_str('1'))), MS.CBORValue.new_int(MS.Int.new_i32(6)));
  key.set_header(MS.Label.new_int(MS.Int.new_negative(MS.BigNum.from_str('2'))), MS.CBORValue.new_bytes(priv.to_public().as_bytes()));
  return { signature: sign1.to_bytes(), key: key.to_bytes() };
}

/** The Sig_structure the reference library reconstructs from a COSE_Sign1. */
export function oracleSignedData(sign1: Uint8Array): Uint8Array {
  return MS.COSESign1.from_bytes(sign1).signed_data().to_bytes();
}

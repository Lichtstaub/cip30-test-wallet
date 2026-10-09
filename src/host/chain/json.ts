import { base58, bech32 } from '@scure/base';

// Chain providers write amounts as raw JSON integers, and native asset
// quantities reach 2^64 - 1. JSON.parse rounds anything above 2^53, and the
// reviver that sees the source text of a number needs Node 21. So the text is
// read once before JSON.parse and every integer literal with more than 15
// digits is put in quotes. Every 15 digit integer is below 2^53 and stays a
// number, longer ones arrive as decimal strings and jsonInteger reads both.

const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
/** A character that continues a number after its integer digits: a digit, '.', 'e', 'E', '+' or '-'. */
const isNumberPart = (c: number) => isDigit(c) || c === 0x2e || c === 0x65 || c === 0x45 || c === 0x2b || c === 0x2d;

/** JSON.parse that turns every integer literal with more than 15 digits into a string, so bigint values survive. */
export function parseJsonBig(text: string): unknown {
  // Without a run of 16 digits there is nothing to quote.
  if (!/\d{16}/.test(text)) return JSON.parse(text);
  let out = '';
  let copied = 0;
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === 0x22) {
      // A string: skip to its closing quote, a backslash escapes the next character.
      i++;
      while (i < text.length && text.charCodeAt(i) !== 0x22) i += text.charCodeAt(i) === 0x5c ? 2 : 1;
      i++;
      continue;
    }
    if (c === 0x2d || isDigit(c)) {
      const start = i;
      if (c === 0x2d) i++;
      const digitsStart = i;
      while (i < text.length && isDigit(text.charCodeAt(i))) i++;
      const digits = i - digitsStart;
      const next = text.charCodeAt(i);
      const integer = next !== 0x2e && next !== 0x65 && next !== 0x45;
      // A leading zero makes the literal invalid JSON, it stays unquoted so JSON.parse refuses it.
      if (integer && digits > 15 && text.charCodeAt(digitsStart) !== 0x30) {
        out += `${text.slice(copied, start)}"${text.slice(start, i)}"`;
        copied = i;
        continue;
      }
      // Fraction and exponent of a number that stays a number.
      while (i < text.length && isNumberPart(text.charCodeAt(i))) i++;
      continue;
    }
    i++;
  }
  return JSON.parse(out + text.slice(copied));
}

/** An integer as parseJsonBig leaves it: a safe integer number or a decimal string. Throws a plain Error naming what otherwise. */
export function jsonInteger(value: unknown, what: string): bigint {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw new Error(`${what} must be an integer, got ${JSON.stringify(value)}`);
}

/** A non-negative integer as parseJsonBig leaves it, a safe number or a digit string, undefined for anything else. */
export function jsonNatural(value: unknown): bigint | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return undefined;
}

/** A JSON object, arrays excluded, or undefined. */
export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** The bytes of an address as chain providers write it: Shelley addresses as bech32, Byron addresses as base58. */
export function addressFromText(value: unknown): Uint8Array {
  if (typeof value !== 'string' || value.length === 0) throw new Error('address must be a string');
  // A base address has 103 characters, so the 90 character limit of BIP-173 is switched off.
  if (value.startsWith('addr')) return bech32.fromWords(bech32.decode(value as `${string}1${string}`, false).words);
  return base58.decode(value);
}

/** addressFromText that decodes each text once, for the rows of one answer. Every call returns its own copy of the bytes. */
export function addressDecoder(): (value: unknown) => Uint8Array {
  const known = new Map<string, Uint8Array>();
  return (value) => {
    if (typeof value !== 'string') return addressFromText(value);
    let bytes = known.get(value);
    if (!bytes) {
      bytes = addressFromText(value);
      known.set(value, bytes);
    }
    return bytes.slice();
  };
}

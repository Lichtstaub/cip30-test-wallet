// Chain providers write amounts as raw JSON integers, and native asset
// quantities reach 2^64 - 1. JSON.parse rounds anything above 2^53, and the
// reviver that sees the source text of a number needs Node 21. So the text is
// read once before JSON.parse and every integer literal with more than 15
// digits is put in quotes. Every 15 digit integer is below 2^53 and stays a
// number, longer ones arrive as decimal strings and jsonInteger reads both.

const isDigit = (c: number) => c >= 0x30 && c <= 0x39;

/** JSON.parse that turns every integer literal with more than 15 digits into a string, so bigint values survive. */
export function parseJsonBig(text: string): unknown {
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
      while (i < text.length && /[0-9.eE+-]/.test(text[i]!)) i++;
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

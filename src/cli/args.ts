/** The value following rest[i], or undefined when the flag is the last argument. next is the index that value was read from. */
export function takeValue(rest: string[], i: number): { value: string; next: number } | undefined {
  const value = rest[i + 1];
  if (value === undefined) return undefined;
  return { value, next: i + 1 };
}

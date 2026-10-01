/** The longest display name, in code points (what a person counts), not UTF-16 units. */
export const DISPLAY_NAME_MAX = 100;

/**
 * A display name as both the invite form and Profile accept it: NFC-normalised, trimmed, 1 to DISPLAY_NAME_MAX code
 * points. Returns the name to store, or undefined when it is not a valid name.
 */
export function validateDisplayName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const name = raw.normalize('NFC').trim();
  const length = [...name].length;
  return length >= 1 && length <= DISPLAY_NAME_MAX ? name : undefined;
}

/** At most DISPLAY_NAME_MAX code points of `name` (never splitting a surrogate pair), e.g. for a flash message. */
export const capName = (name: string): string => [...name].slice(0, DISPLAY_NAME_MAX).join('');

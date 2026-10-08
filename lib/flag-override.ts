// The header that overrides a flag for one request, in a stage that allows it (the stage setting allowFlagOverride).
// Example: "x-lab-flags: show-discounts=on". Several flags are separated by commas: "a=on,b=off".
export const OVERRIDE_HEADER = 'x-lab-flags';

// Same alphabet as a flag key in lab-flags. The first character is a letter, so a name such as __proto__ never matches.
const FLAG_NAME = /^[a-z][a-zA-Z0-9_-]{0,63}$/;

// A real header is a few dozen characters. A longer one is not from a person who tests a flag.
const MAX_HEADER_LENGTH = 512;

// Returns the flags that the header sets, as name to true (on) or false (off).
// A part that is malformed is ignored, and so is a header that is too long. The function never throws.
export function parseFlagOverrides(header: string | undefined): ReadonlyMap<string, boolean> {
  const overrides = new Map<string, boolean>();
  if (header === undefined || header.length > MAX_HEADER_LENGTH) return overrides;
  for (const part of header.split(',')) {
    const pieces = part.split('=');
    if (pieces.length !== 2) continue;
    const name = (pieces[0] ?? '').trim();
    const value = (pieces[1] ?? '').trim().toLowerCase();
    if (!FLAG_NAME.test(name)) continue;
    if (value === 'on') overrides.set(name, true);
    else if (value === 'off') overrides.set(name, false);
  }
  return overrides;
}

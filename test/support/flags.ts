import type { FlagClient } from '../../lib/flag-client.ts';

// Flag clients for the tests of the handler. They need no network and no AWS credentials.
export function flagsFrom(values: Record<string, boolean>): FlagClient {
  return { read: async () => ({ values, fromService: true }) };
}

// The state in Production today: AppConfig answers, and show-discounts is off.
export const flagsOff: FlagClient = flagsFrom({ 'show-discounts': false });
export const flagsOn: FlagClient = flagsFrom({ 'show-discounts': true });

// The flag service is down. The client returns the safe default.
export const flagsDown: FlagClient = { read: async () => ({ values: {}, fromService: false }) };

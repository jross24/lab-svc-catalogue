import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { CoreError, fetchCoreSummary } from './core-client.ts';
import type { CoreSummary } from './core-client.ts';
import { flagClientFromEnv, isEnabled } from './flag-client.ts';
import type { FlagClient } from './flag-client.ts';
import { OVERRIDE_HEADER, parseFlagOverrides } from './flag-override.ts';
import { instrument } from './instrument.ts';
import type { Signals } from './instrument.ts';

type JsonResponse = APIGatewayProxyStructuredResultV2 & { readonly statusCode: number; readonly body: string };

const SERVICE = 'catalogue';
const CORE_FAILED = 'The call to the core service failed.';

// Mock data. A later phase can replace it with a real data store.
const PRODUCTS = [
  { id: 'product-1', name: 'First product', price: 10 },
  { id: 'product-2', name: 'Second product', price: 20 },
] as const;

// The flag show-discounts adds the field discount to each product. The value is a mock: 10 means 10 percent.
const SHOW_DISCOUNTS = 'show-discounts';
const DISCOUNT_PERCENT = 10;

// The one place where the service fails on purpose. The stage config sets INJECT_FAULT for a stage.
// It is a device for the release drill, not a practice for production. See "The Production drill" in the README.
function failOnPurpose(): void {
  if (process.env.INJECT_FAULT === 'true') {
    throw new Error('injected fault: the stage config of this release sets injectFault');
  }
}

function json(statusCode: number, body: Record<string, unknown>): JsonResponse {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    // The stack sets VERSION at synth time, so the response shows which release runs.
    body: JSON.stringify({ service: SERVICE, version: process.env.VERSION ?? 'unknown', ...body }),
  };
}

// Only a stage that sets ALLOW_FLAG_OVERRIDE to "true" accepts the header x-lab-flags (see allowFlagOverride in
// lib/stages.ts). Any other value, or no value, means no override. So a stage that forgets the variable is safe.
function overrideAllowed(): boolean {
  return process.env.ALLOW_FLAG_OVERRIDE === 'true';
}

// Decides the value of show-discounts for one request: the header in a stage that allows it, else the flag service.
// The read of the flag service never rejects. It gives the default (off) when AppConfig fails.
// The function reports what it decided, and the wrapper writes it into the log line of the request.
async function decideShowDiscounts(
  flags: FlagClient,
  headers: Record<string, string | undefined> | undefined,
  signals: Signals,
): Promise<boolean> {
  const reading = await flags.read();
  const override = overrideAllowed() ? parseFlagOverrides(headers?.[OVERRIDE_HEADER]).get(SHOW_DISCOUNTS) : undefined;
  const enabled = override ?? isEnabled(reading, SHOW_DISCOUNTS);
  signals.flags = { [SHOW_DISCOUNTS]: enabled };
  signals.flagsSource = reading.fromService ? 'appconfig' : 'default';
  signals.flagsOverridden = override !== undefined;
  return enabled;
}

// A test gives its own getCore and its own flag client, so it needs no network and no AWS credentials.
// The flag read starts first and runs at the same time as the call to core, so a cold start pays for the slower one only.
export function createHandler(
  getCore: () => Promise<CoreSummary>,
  flags: FlagClient,
): (
  event?: Pick<APIGatewayProxyEventV2, 'headers'>,
  context?: unknown,
  signals?: Signals,
) => Promise<JsonResponse> {
  return async (event, _context, signals = {}) => {
    failOnPurpose();
    const showDiscounts = decideShowDiscounts(flags, event?.headers, signals);
    let core: CoreSummary;
    try {
      core = await getCore();
    } catch (error) {
      // Wait for the flags, so the log line of this request has them.
      await showDiscounts;
      // The log has the full error. The response has only a message that is safe on a public API.
      console.error(CORE_FAILED, error);
      const cause = error instanceof CoreError ? error.message : 'unexpected error';
      return json(502, { error: CORE_FAILED, cause });
    }
    const products = (await showDiscounts)
      ? PRODUCTS.map((product) => ({ ...product, discount: DISCOUNT_PERCENT }))
      : PRODUCTS;
    // The core block proves that the answer passed through the core service.
    return json(200, { core, products });
  };
}

// The wrapper writes one log line and one metric line for each request. A 502 from a failed call to core counts as
// an error in the metric line. Lambda does not count it, because the function returns and does not throw.
export const handler = instrument({ service: SERVICE }, createHandler(() => fetchCoreSummary(), flagClientFromEnv()));

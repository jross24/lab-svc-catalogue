import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreError } from '../lib/core-client.ts';
import type { Signals } from '../lib/instrument.ts';
import { createHandler } from '../lib/products-handler.ts';
import { flagsDown, flagsFrom, flagsOff, flagsOn } from './support/flags.ts';

// The handler reads its flags with the AppConfig data API. This fake is the network boundary: the test sets what
// AppConfig answers, and no test needs the AWS SDK, a network or credentials.
const appConfig = vi.hoisted(() => ({ answer: '{"show-discounts":{"enabled":false}}' as string | Error, reads: 0 }));
vi.mock('../lib/appconfig-data.ts', () => ({
  sdkAppConfigDataApi: () => ({
    startSession: async () => 'token',
    getLatest: async () => {
      appConfig.reads += 1;
      if (appConfig.answer instanceof Error) throw appConfig.answer;
      return { nextToken: 'token', content: appConfig.answer, pollIntervalSeconds: 15 };
    },
  }),
}));

afterEach(() => {
  appConfig.answer = '{"show-discounts":{"enabled":false}}';
  appConfig.reads = 0;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const coreAnswers = async () => ({ version: '0.3.0', itemCount: 3 });
const CONTEXT = { awsRequestId: 'req-7' } as Context;

type Flags = Parameters<typeof createHandler>[1];
type Reported = Signals;

function eventWith(header: string | undefined): APIGatewayProxyEventV2 {
  // API Gateway gives the names of the headers in lower case.
  return { routeKey: 'GET /products', headers: header === undefined ? {} : { 'x-lab-flags': header } } as unknown as APIGatewayProxyEventV2;
}

// True when every product in the answer has a discount of 10.
async function hasDiscount(flags: Flags, header?: string, reported: Reported = {}): Promise<boolean> {
  const response = await createHandler(coreAnswers, flags)(eventWith(header), CONTEXT, reported);
  const products = (JSON.parse(response.body) as { products: { discount?: number }[] }).products;
  return products.every((product) => product.discount === 10);
}

describe('the flag show-discounts', () => {
  const PRODUCTS_WITHOUT_DISCOUNT = [
    { id: 'product-1', name: 'First product', price: 10 },
    { id: 'product-2', name: 'Second product', price: 20 },
  ];

  async function productsOf(flags: Flags): Promise<unknown> {
    const response = await createHandler(coreAnswers, flags)();
    return (JSON.parse(response.body) as { products: unknown }).products;
  }

  it('leaves the answer exactly as before when the flag is off', async () => {
    const response = await createHandler(coreAnswers, flagsOff)();
    expect(JSON.parse(response.body)).toEqual({
      service: 'catalogue',
      version: 'unknown',
      core: { version: '0.3.0', itemCount: 3 },
      products: PRODUCTS_WITHOUT_DISCOUNT,
    });
    expect(response.body).not.toContain('discount');
  });

  it('adds a discount of 10 percent to each product when the flag is on', async () => {
    expect(await productsOf(flagsOn)).toEqual(PRODUCTS_WITHOUT_DISCOUNT.map((product) => ({ ...product, discount: 10 })));
  });

  it('adds no discount when the flag service is down (the safe default is off)', async () => {
    expect(await productsOf(flagsDown)).toEqual(PRODUCTS_WITHOUT_DISCOUNT);
  });

  it('adds no discount when the flag service does not know the flag', async () => {
    expect(await productsOf(flagsFrom({ 'other-flag': true }))).toEqual(PRODUCTS_WITHOUT_DISCOUNT);
  });

  it('still answers 502 when core fails, and the flag does not change that', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await createHandler(async () => {
      throw new CoreError('core returned HTTP 500');
    }, flagsOn)();
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain('discount');
  });
});

describe('the override header in a stage that allows it (ALLOW_FLAG_OVERRIDE is "true")', () => {
  it('turns the flag on for one request with show-discounts=on', async () => {
    vi.stubEnv('ALLOW_FLAG_OVERRIDE', 'true');
    expect(await hasDiscount(flagsOff, 'show-discounts=on')).toBe(true);
  });

  it('turns the flag off for one request with show-discounts=off', async () => {
    vi.stubEnv('ALLOW_FLAG_OVERRIDE', 'true');
    expect(await hasDiscount(flagsOn, 'show-discounts=off')).toBe(false);
  });

  it('does not change the next request that has no header', async () => {
    vi.stubEnv('ALLOW_FLAG_OVERRIDE', 'true');
    expect(await hasDiscount(flagsOff, 'show-discounts=on')).toBe(true);
    expect(await hasDiscount(flagsOff)).toBe(false);
  });

  it('works also when the flag service is down', async () => {
    vi.stubEnv('ALLOW_FLAG_OVERRIDE', 'true');
    expect(await hasDiscount(flagsDown, 'show-discounts=on')).toBe(true);
  });

  it.each([
    ['no header', undefined],
    ['a header with no equals sign', 'show-discounts'],
    ['an empty value', 'show-discounts='],
    ['a value that is not on or off', 'show-discounts=yes'],
    ['two equals signs', 'show-discounts==on'],
    ['a header about another flag', 'other-flag=on'],
    ['text that is not a list of flags', '<script>'],
  ])('ignores %s (a malformed header changes nothing)', async (_name, header) => {
    vi.stubEnv('ALLOW_FLAG_OVERRIDE', 'true');
    expect(await hasDiscount(flagsOff, header)).toBe(false);
    expect(await hasDiscount(flagsOn, header)).toBe(true);
  });

  it('reports the effective flags, the source of the values and the override, for the log line', async () => {
    vi.stubEnv('ALLOW_FLAG_OVERRIDE', 'true');
    const reported: Reported = {};
    await hasDiscount(flagsOff, 'show-discounts=on', reported);
    expect(reported).toEqual({ flags: { 'show-discounts': true }, flagsSource: 'appconfig', flagsOverridden: true });
  });

  it('reports an override that gives the same value as the service as an override too', async () => {
    vi.stubEnv('ALLOW_FLAG_OVERRIDE', 'true');
    const reported: Reported = {};
    await hasDiscount(flagsOff, 'show-discounts=off', reported);
    expect(reported).toMatchObject({ flags: { 'show-discounts': false }, flagsOverridden: true });
  });

  it('reports no override for a malformed header', async () => {
    vi.stubEnv('ALLOW_FLAG_OVERRIDE', 'true');
    const reported: Reported = {};
    await hasDiscount(flagsOff, 'show-discounts=maybe', reported);
    expect(reported).toMatchObject({ flagsOverridden: false });
  });
});

describe('the override header in a stage that does not allow it (Staging and Production)', () => {
  it.each([
    ['not set', undefined],
    ['false', 'false'],
    ['empty', ''],
    ['TRUE', 'TRUE'],
    ['1', '1'],
  ])('ignores the header, on and off, when ALLOW_FLAG_OVERRIDE is %s', async (_name, value) => {
    vi.stubEnv('ALLOW_FLAG_OVERRIDE', value);
    expect(await hasDiscount(flagsOff, 'show-discounts=on')).toBe(false);
    expect(await hasDiscount(flagsOn, 'show-discounts=off')).toBe(true);
  });

  it('reports that the request was not overridden', async () => {
    vi.stubEnv('ALLOW_FLAG_OVERRIDE', 'false');
    const reported: Reported = {};
    await hasDiscount(flagsOff, 'show-discounts=on', reported);
    expect(reported).toEqual({ flags: { 'show-discounts': false }, flagsSource: 'appconfig', flagsOverridden: false });
  });

  it('reports the source "default" when the flag service is down', async () => {
    const reported: Reported = {};
    await hasDiscount(flagsDown, undefined, reported);
    expect(reported).toEqual({ flags: { 'show-discounts': false }, flagsSource: 'default', flagsOverridden: false });
  });
});

// These tests use the real exported handler, the real flag client and the real log line. The fake is AppConfig.
// The handler also needs a fake core: a fake fetch plays the API of core. The credentials are the example values
// from the AWS documentation.
describe('the handler of the function, with the flag client of the function', () => {
  function stubEnvironment(): void {
    vi.stubEnv('VERSION', '1.2.3');
    vi.stubEnv('CORE_URL', 'https://abc123.execute-api.eu-west-2.amazonaws.com');
    vi.stubEnv('AWS_REGION', 'eu-west-2');
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIAIOSFODNN7EXAMPLE');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
    vi.stubEnv('AWS_SESSION_TOKEN', 'fake-session-token');
    vi.stubEnv('INJECT_FAULT', undefined);
    vi.stubEnv('FLAGS_APPLICATION_ID', 'app1234');
    vi.stubEnv('FLAGS_ENVIRONMENT_ID', 'env5678');
    vi.stubEnv('FLAGS_PROFILE_ID', 'prof9012');
    vi.stubEnv('ALLOW_FLAG_OVERRIDE', undefined);
  }

  function collectStdout(): string[] {
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    return written;
  }

  function fakeCore(answer: () => Response): void {
    vi.stubGlobal('fetch', vi.fn(async () => answer()));
  }

  const CORE_OK = () => Response.json({ service: 'core', version: '0.3.0', items: [] });

  async function freshHandler() {
    // The module makes its flag client when it loads, so each test loads a fresh copy.
    vi.resetModules();
    return (await import('../lib/products-handler.ts')).handler;
  }

  function parsed(written: string[]): Record<string, unknown>[] {
    return written.map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it('reads the flag from AppConfig, leaves the answer unchanged when it is off, and logs the flag state', async () => {
    stubEnvironment();
    const written = collectStdout();
    fakeCore(CORE_OK);
    const handler = await freshHandler();
    const response = await handler(eventWith(undefined), CONTEXT);
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('discount');
    expect(appConfig.reads).toBe(1);
    expect(written).toHaveLength(2);
    expect(parsed(written)[0]).toMatchObject({
      status: 200,
      flags: { 'show-discounts': false },
      flagsSource: 'appconfig',
      flagsOverridden: false,
    });
  });

  it('adds the discount when AppConfig turns the flag on', async () => {
    stubEnvironment();
    appConfig.answer = '{"show-discounts":{"enabled":true}}';
    collectStdout();
    fakeCore(CORE_OK);
    const handler = await freshHandler();
    const response = await handler(eventWith(undefined), CONTEXT);
    expect(JSON.parse(response.body)).toMatchObject({ products: [{ discount: 10 }, { discount: 10 }] });
  });

  it('reads AppConfig once for the requests inside the cache time', async () => {
    stubEnvironment();
    collectStdout();
    fakeCore(CORE_OK);
    const handler = await freshHandler();
    await handler(eventWith(undefined), CONTEXT);
    await handler(eventWith(undefined), CONTEXT);
    await handler(eventWith(undefined), CONTEXT);
    expect(appConfig.reads).toBe(1);
  });

  it('does not fail the request when AppConfig fails: it answers 200 with the default and writes one warning', async () => {
    stubEnvironment();
    appConfig.answer = new Error('the flag service is down');
    const written = collectStdout();
    fakeCore(CORE_OK);
    const handler = await freshHandler();
    const response = await handler(eventWith(undefined), CONTEXT);
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('discount');
    const lines = parsed(written);
    const warnings = lines.filter((line) => line['event'] === 'flag-read-failed');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ level: 'WARN', error: 'Error: the flag service is down' });
    expect(lines.find((line) => line['route'] === 'GET /products')).toMatchObject({
      level: 'INFO',
      status: 200,
      flags: { 'show-discounts': false },
      flagsSource: 'default',
      flagsOverridden: false,
    });
  });

  it('applies the header in a stage that allows it, and logs the override', async () => {
    stubEnvironment();
    vi.stubEnv('ALLOW_FLAG_OVERRIDE', 'true');
    const written = collectStdout();
    fakeCore(CORE_OK);
    const handler = await freshHandler();
    const response = await handler(eventWith('show-discounts=on'), CONTEXT);
    expect(JSON.parse(response.body)).toMatchObject({ products: [{ discount: 10 }, { discount: 10 }] });
    expect(parsed(written)[0]).toMatchObject({
      flags: { 'show-discounts': true },
      flagsSource: 'appconfig',
      flagsOverridden: true,
    });
  });

  it('ignores the header in a stage that does not allow it', async () => {
    stubEnvironment();
    const written = collectStdout();
    fakeCore(CORE_OK);
    const handler = await freshHandler();
    const response = await handler(eventWith('show-discounts=on'), CONTEXT);
    expect(response.body).not.toContain('discount');
    expect(parsed(written)[0]).toMatchObject({ flags: { 'show-discounts': false }, flagsOverridden: false });
  });

  it('answers 502 and still logs the flags when core fails', async () => {
    stubEnvironment();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const written = collectStdout();
    fakeCore(() => new Response('{}', { status: 403 }));
    const handler = await freshHandler();
    const response = await handler(eventWith(undefined), CONTEXT);
    expect(response.statusCode).toBe(502);
    expect(parsed(written)[0]).toMatchObject({ status: 502, flags: { 'show-discounts': false }, flagsSource: 'appconfig' });
  });
});

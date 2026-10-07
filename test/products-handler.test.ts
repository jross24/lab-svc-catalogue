import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreError } from '../lib/core-client.ts';
import { createHandler, handler } from '../lib/products-handler.ts';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const coreAnswers = async () => ({ version: '0.3.0', itemCount: 3 });

describe('products handler when core answers', () => {
  it('returns JSON with status 200', async () => {
    const response = await createHandler(coreAnswers)();
    expect(response.statusCode).toBe(200);
    expect(response.headers).toEqual({ 'content-type': 'application/json' });
  });

  it('returns its own name and version, the version and item count of core, and the products', async () => {
    vi.stubEnv('VERSION', '1.2.3');
    const body: unknown = JSON.parse((await createHandler(coreAnswers)()).body);
    expect(body).toEqual({
      service: 'catalogue',
      version: '1.2.3',
      core: { version: '0.3.0', itemCount: 3 },
      products: [
        { id: 'product-1', name: 'First product', price: 10 },
        { id: 'product-2', name: 'Second product', price: 20 },
      ],
    });
  });

  it('returns the version "unknown" when the environment has no version', async () => {
    vi.stubEnv('VERSION', undefined);
    const body: unknown = JSON.parse((await createHandler(coreAnswers)()).body);
    expect(body).toMatchObject({ version: 'unknown' });
  });
});

describe('products handler when the core call fails', () => {
  it('returns status 502 with a JSON error that names the cause', async () => {
    vi.stubEnv('VERSION', '1.2.3');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await createHandler(async () => {
      throw new CoreError('core returned HTTP 403');
    })();
    expect(response.statusCode).toBe(502);
    expect(response.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(response.body)).toEqual({
      service: 'catalogue',
      version: '1.2.3',
      error: 'The call to the core service failed.',
      cause: 'core returned HTTP 403',
    });
  });

  it('does not show the message of an unexpected error to the caller, and logs it', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const unexpected = new Error('internal detail');
    const response = await createHandler(async () => {
      throw unexpected;
    })();
    expect(response.statusCode).toBe(502);
    expect(JSON.parse(response.body)).toMatchObject({ cause: 'unexpected error' });
    expect(response.body).not.toContain('internal detail');
    expect(log).toHaveBeenCalledWith('The call to the core service failed.', unexpected);
  });
});

describe('products handler fault switch', () => {
  const getCore = vi.fn(coreAnswers);

  it('throws when INJECT_FAULT is "true", so that Lambda counts an error, and does not call core', async () => {
    getCore.mockClear();
    vi.stubEnv('INJECT_FAULT', 'true');
    await expect(createHandler(getCore)()).rejects.toThrow(/injected fault/);
    expect(getCore).not.toHaveBeenCalled();
  });

  it.each(['false', '', 'TRUE', '1'])('does not throw when INJECT_FAULT is %j', async (value) => {
    vi.stubEnv('INJECT_FAULT', value);
    await expect(createHandler(coreAnswers)()).resolves.toMatchObject({ statusCode: 200 });
  });

  it('does not throw when INJECT_FAULT is not set', async () => {
    vi.stubEnv('INJECT_FAULT', undefined);
    await expect(createHandler(coreAnswers)()).resolves.toMatchObject({ statusCode: 200 });
  });
});

// The tests below call the real exported handler. The only fake is core, at the network boundary:
// a fake fetch plays the API of core, and the fake credentials are the example values from the AWS documentation.
const EVENT = { routeKey: 'GET /products' } as APIGatewayProxyEventV2;
const CONTEXT = { awsRequestId: 'req-7' } as Context;

function stubEnvironment(): void {
  vi.stubEnv('VERSION', '1.2.3');
  vi.stubEnv('CORE_URL', 'https://abc123.execute-api.eu-west-2.amazonaws.com');
  vi.stubEnv('AWS_REGION', 'eu-west-2');
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIAIOSFODNN7EXAMPLE');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
  vi.stubEnv('AWS_SESSION_TOKEN', 'fake-session-token');
  vi.stubEnv('INJECT_FAULT', undefined);
}

// The handler writes its log line and its metric line to stdout. Collect them, and keep the test output clean.
function collectStdout(): string[] {
  const written: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  });
  return written;
}

function fakeCore(answer: () => Response | Promise<Response>) {
  const fetch = vi.fn(async () => answer());
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('products handler telemetry with a fake core', () => {
  it('writes an INFO log line and a metric line with no error when core answers', async () => {
    stubEnvironment();
    const written = collectStdout();
    fakeCore(() => Response.json({ service: 'core', version: '0.3.0', items: [{ id: 'item-1' }] }));
    const response = await handler(EVENT, CONTEXT);
    expect(response.statusCode).toBe(200);
    expect(written).toHaveLength(2);
    expect(JSON.parse(written[0] ?? '')).toMatchObject({
      level: 'INFO',
      service: 'catalogue',
      version: '1.2.3',
      requestId: 'req-7',
      route: 'GET /products',
      status: 200,
    });
    expect(JSON.parse(written[1] ?? '')).toMatchObject({ service: 'catalogue', version: '1.2.3', requests: 1, errors: 0 });
  });

  // Catalogue answers 502 when the call to core fails, and it does not throw. Lambda counts a call as an error only
  // when the function throws or times out. So the Lambda Errors alarm cannot see these calls. The metric line must
  // count them, because the third alarm of the release gate (serviceErrors) reads that metric.
  it.each([
    ['core answers HTTP 403', () => new Response('{"Message":"a detail that the caller must not see"}', { status: 403 })],
    ['core answers HTTP 500', () => new Response('internal error', { status: 500 })],
    ['core answers a body that the service does not understand', () => new Response('not json')],
    [
      'the request to core fails',
      () => {
        throw new TypeError('fetch failed');
      },
    ],
  ])('returns 502, writes an ERROR log line and counts one error when %s', async (_name, answer) => {
    stubEnvironment();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const written = collectStdout();
    const core = fakeCore(answer);

    // The handler resolves. It does not throw, so Lambda sees a good call.
    const response = await handler(EVENT, CONTEXT);

    expect(core).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain('a detail that the caller must not see');
    expect(written).toHaveLength(2);
    expect(JSON.parse(written[0] ?? '')).toMatchObject({
      level: 'ERROR',
      service: 'catalogue',
      version: '1.2.3',
      route: 'GET /products',
      status: 502,
    });
    expect(JSON.parse(written[1] ?? '')).toMatchObject({
      service: 'catalogue',
      version: '1.2.3',
      requests: 1,
      errors: 1,
    });
  });

  it('keeps the full error in a text line of the log', async () => {
    stubEnvironment();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    collectStdout();
    fakeCore(() => new Response('{}', { status: 403 }));
    await handler(EVENT, CONTEXT);
    expect(log).toHaveBeenCalledWith('The call to the core service failed.', expect.any(CoreError));
  });

  it('throws with INJECT_FAULT, logs an ERROR line with status 500 and counts one error', async () => {
    stubEnvironment();
    vi.stubEnv('INJECT_FAULT', 'true');
    const written = collectStdout();
    const core = fakeCore(() => Response.json({ version: '0.3.0', items: [] }));
    await expect(handler(EVENT, CONTEXT)).rejects.toThrow(/injected fault/);
    expect(core).not.toHaveBeenCalled();
    expect(JSON.parse(written[0] ?? '')).toMatchObject({ level: 'ERROR', status: 500 });
    expect(JSON.parse(written[1] ?? '')).toMatchObject({ errors: 1 });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { CoreError, fetchCoreSummary } from '../lib/core-client.ts';
import type { CoreClientOptions } from '../lib/core-client.ts';
import { signGet } from '../lib/sign.ts';
import { Tracing } from '../lib/tracing.ts';

// Fake values. The credentials are the example values from the AWS documentation and open nothing.
const ENV = {
  CORE_URL: 'https://abc123.execute-api.eu-west-2.amazonaws.com',
  AWS_REGION: 'eu-west-2',
  AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
  AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  AWS_SESSION_TOKEN: 'fake-session-token',
};

const CORE_BODY = {
  service: 'core',
  version: '0.3.0',
  items: [
    { id: 'item-1', title: 'First item' },
    { id: 'item-2', title: 'Second item' },
  ],
};

function options(response: Response | Error, env: Record<string, string | undefined> = ENV) {
  const fetch = vi.fn<NonNullable<CoreClientOptions['fetch']>>(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  return { fetch, env };
}

function failure(opts: CoreClientOptions): Promise<unknown> {
  return fetchCoreSummary(opts).then(
    () => undefined,
    (caught: unknown) => caught,
  );
}

describe('fetchCoreSummary', () => {
  it('returns the version of core and the number of items', async () => {
    const summary = await fetchCoreSummary(options(Response.json(CORE_BODY)));
    expect(summary).toEqual({ version: '0.3.0', itemCount: 2 });
  });

  it('sends one signed GET request to /items of the core URL', async () => {
    const opts = options(Response.json(CORE_BODY));
    await fetchCoreSummary(opts);
    expect(opts.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = opts.fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://abc123.execute-api.eu-west-2.amazonaws.com/items');
    expect(init?.method).toBe('GET');
    expect(init?.headers.authorization).toMatch(/\/eu-west-2\/execute-api\/aws4_request/);
    expect(init?.headers['x-amz-security-token']).toBe('fake-session-token');
  });

  it('throws a CoreError with the status when core does not return 200', async () => {
    const forbidden = new Response('{"Message":"a detail that the caller must not see"}', { status: 403 });
    const error = await failure(options(forbidden));
    expect(error).toBeInstanceOf(CoreError);
    expect(error).toHaveProperty('message', 'core returned HTTP 403');
  });

  it('throws a CoreError when the request fails', async () => {
    const error = await failure(options(new TypeError('fetch failed')));
    expect(error).toBeInstanceOf(CoreError);
    expect(error).toHaveProperty('message', 'the request to core failed');
  });

  it.each(['not json', '{"service":"core"}', '{"version":1,"items":[]}', '{"version":"1.0.0","items":{}}'])(
    'throws a CoreError when the body is %j',
    async (body) => {
      const error = await failure(options(new Response(body)));
      expect(error).toBeInstanceOf(CoreError);
      expect(error).toHaveProperty('message', 'core returned a body that this service does not understand');
    },
  );

  it.each(['CORE_URL', 'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'])(
    'throws a CoreError and sends no request when the environment has no %s',
    async (name) => {
      const opts = options(Response.json(CORE_BODY), { ...ENV, [name]: undefined });
      const error = await failure(opts);
      expect(error).toBeInstanceOf(CoreError);
      expect(error).toHaveProperty('message', `the environment variable ${name} is not set`);
      expect(opts.fetch).not.toHaveBeenCalled();
    },
  );
});

describe('fetchCoreSummary with tracing', () => {
  const NOW = new Date('2026-10-07T20:15:30.000Z');
  const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/;

  // The signature holds the time of the request. A fixed clock gives the signature that the test expects.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function traced(response: Response | Error = Response.json(CORE_BODY)) {
    const memory = new InMemorySpanExporter();
    const tracing = Tracing.create({ service: 'catalogue', version: '1.2.3', exporter: memory });
    return { memory, tracing, ...options(response), env: ENV };
  }

  // The headers that the request has without tracing: the signature of the same request at the same time.
  function signedWithoutTracing(): Promise<Record<string, string>> {
    return signGet({
      url: `${ENV.CORE_URL}/items`,
      region: ENV.AWS_REGION,
      credentials: {
        accessKeyId: ENV.AWS_ACCESS_KEY_ID,
        secretAccessKey: ENV.AWS_SECRET_ACCESS_KEY,
        sessionToken: ENV.AWS_SESSION_TOKEN,
      },
      now: NOW,
    });
  }

  function sentHeaders(sent: ReturnType<typeof traced>): Record<string, string> {
    expect(sent.fetch).toHaveBeenCalledTimes(1);
    return sent.fetch.mock.calls[0]?.[1].headers ?? {};
  }

  it('sends the signed headers unchanged and adds the header traceparent', async () => {
    const run = traced();
    await run.tracing.serve({ name: 'GET /products' }, () => fetchCoreSummary(run));
    expect(sentHeaders(run)).toEqual({ ...(await signedWithoutTracing()), traceparent: expect.stringMatching(TRACEPARENT) });
  });

  it('does not put traceparent or x-amzn-trace-id into the list of signed headers', async () => {
    const run = traced();
    await run.tracing.serve({ name: 'GET /products' }, () => fetchCoreSummary(run));
    const list = /SignedHeaders=([^,]+)/.exec(sentHeaders(run).authorization ?? '')?.[1]?.split(';') ?? [];
    expect(list).toEqual(expect.arrayContaining(['host', 'x-amz-date']));
    expect(list).not.toContain('traceparent');
    expect(list).not.toContain('tracestate');
    expect(list).not.toContain('x-amzn-trace-id');
  });

  it('records a client span for the call as a child of the server span, and sends the ID of the client span', async () => {
    const run = traced();
    await run.tracing.serve({ name: 'GET /products' }, () => fetchCoreSummary(run));
    const spans = run.memory.getFinishedSpans();
    const server = spans.find((span) => span.kind === SpanKind.SERVER);
    const clients = spans.filter((span) => span.kind === SpanKind.CLIENT);
    expect(spans).toHaveLength(2);
    expect(clients).toHaveLength(1);
    const client = clients[0];
    expect(client?.name).toBe('GET abc123.execute-api.eu-west-2.amazonaws.com');
    expect(client?.parentSpanContext?.spanId).toBe(server?.spanContext().spanId);
    expect(client?.spanContext().traceId).toBe(server?.spanContext().traceId);
    expect(client?.attributes).toMatchObject({
      'http.response.status_code': 200,
      'url.full': 'https://abc123.execute-api.eu-west-2.amazonaws.com/items',
    });
    expect(sentHeaders(run).traceparent).toBe(`00-${server?.spanContext().traceId}-${client?.spanContext().spanId}-01`);
  });

  it('continues the trace of the caller of the service', async () => {
    const run = traced();
    const caller = { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' };
    await run.tracing.serve({ name: 'GET /products', headers: caller }, () => fetchCoreSummary(run));
    expect(sentHeaders(run).traceparent).toMatch(/^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/);
  });

  it('sends the headers with no change outside of a server span, and records no span', async () => {
    const run = traced();
    await fetchCoreSummary(run);
    expect(sentHeaders(run)).toEqual(await signedWithoutTracing());
    expect(sentHeaders(run)).not.toHaveProperty('traceparent');
    expect(run.memory.getFinishedSpans()).toHaveLength(0);
  });

  it('marks the client span as an error when core answers 403, and still throws the same safe CoreError', async () => {
    const run = traced(new Response('{"Message":"a detail that the caller must not see"}', { status: 403 }));
    let error: unknown;
    await run.tracing.serve({ name: 'GET /products' }, async () => {
      error = await failure(run);
    });
    expect(error).toBeInstanceOf(CoreError);
    expect(error).toHaveProperty('message', 'core returned HTTP 403');
    const client = run.memory.getFinishedSpans().find((span) => span.kind === SpanKind.CLIENT);
    expect(client?.status.code).toBe(SpanStatusCode.ERROR);
    expect(client?.attributes['http.response.status_code']).toBe(403);
    expect(JSON.stringify([client?.attributes, client?.status, client?.events])).not.toContain('a detail');
  });

  it('records a failed request on the client span, and still throws the same safe CoreError', async () => {
    const run = traced(new TypeError('fetch failed'));
    let error: unknown;
    await run.tracing.serve({ name: 'GET /products' }, async () => {
      error = await failure(run);
    });
    expect(error).toBeInstanceOf(CoreError);
    expect(error).toHaveProperty('message', 'the request to core failed');
    const client = run.memory.getFinishedSpans().find((span) => span.kind === SpanKind.CLIENT);
    expect(client?.status.code).toBe(SpanStatusCode.ERROR);
    expect(client?.events.map((event) => event.name)).toContain('exception');
  });

  it('sends no request and records no client span when the environment is not complete', async () => {
    const run = { ...traced(), env: { ...ENV, AWS_REGION: undefined } };
    await run.tracing.serve({ name: 'GET /products' }, async () => {
      await failure(run);
    });
    expect(run.fetch).not.toHaveBeenCalled();
    expect(run.memory.getFinishedSpans().filter((span) => span.kind === SpanKind.CLIENT)).toHaveLength(0);
  });
});

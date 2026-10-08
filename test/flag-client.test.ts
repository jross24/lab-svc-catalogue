import { describe, expect, it, vi } from 'vitest';
import { createFlagClient, flagClientFromEnv, isEnabled } from '../lib/flag-client.ts';
import type { AppConfigDataApi, FlagClientOptions, FlagLocation } from '../lib/flag-client.ts';

const LOCATION: FlagLocation = { applicationId: 'app1234', environmentId: 'env5678', profileId: 'prof9012' };
const ON = '{"show-discounts":{"enabled":true}}';
const OFF = '{"show-discounts":{"enabled":false}}';

// A scripted AppConfig data API. Each call of getLatest takes the next answer. An Error rejects. The empty string
// means "no new configuration", which is what AppConfig answers when the caller already has the latest.
function fakeApi(answers: (string | Error)[]) {
  let tokens = 0;
  const startSession = vi.fn<AppConfigDataApi['startSession']>(async () => `initial-${++tokens}`);
  const getLatest = vi.fn<AppConfigDataApi['getLatest']>(async () => {
    const answer = answers.shift();
    if (answer === undefined) throw new Error('the test has no more answers');
    if (answer instanceof Error) throw answer;
    return { nextToken: `next-${++tokens}`, content: answer, pollIntervalSeconds: 15 };
  });
  const api: AppConfigDataApi = { startSession, getLatest };
  return { api, startSession, getLatest };
}

function setup(answers: (string | Error)[], options: Partial<FlagClientOptions> = {}) {
  const fake = fakeApi(answers);
  const clock = { time: 1_000_000 };
  const warnings: Record<string, unknown>[] = [];
  const client = createFlagClient({
    api: fake.api,
    location: () => LOCATION,
    now: () => clock.time,
    warn: (line) => warnings.push(JSON.parse(line) as Record<string, unknown>),
    ...options,
  });
  return { ...fake, client, clock, warnings };
}

describe('flag client: reading', () => {
  it('parses the feature-flag content of AppConfig into one boolean for each flag', async () => {
    const { client } = setup(['{"show-discounts":{"enabled":true},"new-menu":{"enabled":false}}']);
    const reading = await client.read();
    expect(reading).toEqual({ values: { 'show-discounts': true, 'new-menu': false }, fromService: true });
  });

  it('starts a session with the three IDs, then asks for the configuration with the session token', async () => {
    const { client, startSession, getLatest } = setup([OFF]);
    await client.read();
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(startSession.mock.calls[0]?.[0]).toEqual(LOCATION);
    expect(getLatest).toHaveBeenCalledTimes(1);
    expect(getLatest.mock.calls[0]?.[0]).toBe('initial-1');
  });

  it('ignores an entry that has no boolean "enabled", and keeps the other entries', async () => {
    const { client } = setup(['{"a":{"enabled":"yes"},"b":{"enabled":true},"c":5,"d":null,"e":{}}']);
    expect((await client.read()).values).toEqual({ b: true });
  });

  it('answers false for a flag that the content does not have (the safe default)', async () => {
    const { client } = setup([OFF]);
    const reading = await client.read();
    expect(isEnabled(reading, 'no-such-flag')).toBe(false);
    expect(isEnabled(reading, 'show-discounts')).toBe(false);
  });

  it('answers true only for a flag that the content turns on', async () => {
    const { client } = setup([ON]);
    expect(isEnabled(await client.read(), 'show-discounts')).toBe(true);
  });
});

describe('flag client: cache', () => {
  it('serves a second read from memory inside the cache time', async () => {
    const { client, getLatest, clock } = setup([ON]);
    await client.read();
    clock.time += 29_999;
    expect(isEnabled(await client.read(), 'show-discounts')).toBe(true);
    expect(getLatest).toHaveBeenCalledTimes(1);
  });

  it('asks again after the cache time, with the token of the last answer and no new session', async () => {
    const { client, getLatest, startSession, clock } = setup([OFF, ON]);
    expect(isEnabled(await client.read(), 'show-discounts')).toBe(false);
    clock.time += 30_000;
    expect(isEnabled(await client.read(), 'show-discounts')).toBe(true);
    expect(getLatest).toHaveBeenCalledTimes(2);
    expect(getLatest.mock.calls[1]?.[0]).toBe('next-2');
    expect(startSession).toHaveBeenCalledTimes(1);
  });

  it('keeps the last flags when AppConfig answers with no content (nothing changed)', async () => {
    const { client, clock } = setup([ON, '']);
    await client.read();
    clock.time += 30_000;
    const reading = await client.read();
    expect(reading).toEqual({ values: { 'show-discounts': true }, fromService: true });
  });

  it('uses a longer cache time when AppConfig asks for a longer poll interval', async () => {
    const { api, getLatest } = fakeApi([OFF, OFF]);
    const clock = { time: 0 };
    const slow: AppConfigDataApi = {
      startSession: api.startSession,
      getLatest: async (token, signal) => ({ ...(await api.getLatest(token, signal)), pollIntervalSeconds: 120 }),
    };
    const client = createFlagClient({ api: slow, location: () => LOCATION, now: () => clock.time });
    await client.read();
    clock.time += 60_000;
    await client.read();
    expect(getLatest).toHaveBeenCalledTimes(1);
    clock.time += 60_000;
    await client.read();
    expect(getLatest).toHaveBeenCalledTimes(2);
  });

  it('makes one call to AppConfig for reads that run at the same time', async () => {
    const { client, getLatest } = setup([ON]);
    const readings = await Promise.all([client.read(), client.read(), client.read()]);
    expect(getLatest).toHaveBeenCalledTimes(1);
    for (const reading of readings) expect(isEnabled(reading, 'show-discounts')).toBe(true);
  });
});

describe('flag client: failure', () => {
  it('returns the default when the session does not start, and logs one structured warning', async () => {
    const { client, startSession, warnings } = setup([]);
    startSession.mockRejectedValueOnce(Object.assign(new Error('not allowed'), { name: 'AccessDeniedException' }));
    const reading = await client.read();
    expect(reading).toEqual({ values: {}, fromService: false });
    expect(isEnabled(reading, 'show-discounts')).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      level: 'WARN',
      event: 'flag-read-failed',
      error: 'AccessDeniedException: not allowed',
    });
    expect(typeof warnings[0]?.['timestamp']).toBe('string');
  });

  it('returns the default when the read fails', async () => {
    const { client, warnings } = setup([new Error('boom')]);
    expect(await client.read()).toEqual({ values: {}, fromService: false });
    expect(warnings).toHaveLength(1);
  });

  it('never rejects, also when the failure is not an Error', async () => {
    const { client, getLatest, warnings } = setup([]);
    getLatest.mockRejectedValueOnce('a string');
    await expect(client.read()).resolves.toEqual({ values: {}, fromService: false });
    expect(warnings[0]).toMatchObject({ error: 'a string' });
  });

  it.each([
    ['text that is not JSON', 'not json'],
    ['a JSON array', '[]'],
    ['a JSON string', '"show-discounts"'],
    ['JSON null', 'null'],
  ])('returns the default when the content is %s', async (_name, content) => {
    const { client, warnings } = setup([content]);
    expect(await client.read()).toEqual({ values: {}, fromService: false });
    expect(warnings).toHaveLength(1);
  });

  it('returns the default, not the old value, when a later read fails (a flag that is on goes back to off)', async () => {
    const { client, clock } = setup([ON, new Error('boom')]);
    expect(isEnabled(await client.read(), 'show-discounts')).toBe(true);
    clock.time += 30_000;
    expect(isEnabled(await client.read(), 'show-discounts')).toBe(false);
  });

  it('does not ask AppConfig again inside the failure time, so a flag outage does not slow each request', async () => {
    const { client, getLatest, warnings, clock } = setup([new Error('boom')]);
    await client.read();
    clock.time += 9_999;
    expect(await client.read()).toEqual({ values: {}, fromService: false });
    expect(getLatest).toHaveBeenCalledTimes(1);
    expect(warnings).toHaveLength(1);
  });

  it('recovers after the failure time with a new session', async () => {
    const { client, startSession, clock, warnings } = setup([new Error('boom'), ON]);
    await client.read();
    clock.time += 10_000;
    const reading = await client.read();
    expect(isEnabled(reading, 'show-discounts')).toBe(true);
    expect(reading.fromService).toBe(true);
    expect(startSession).toHaveBeenCalledTimes(2);
    expect(warnings).toHaveLength(1);
  });

  it('returns the default when the location is not known, for example when the environment is not set', async () => {
    const { client, startSession, warnings } = setup([OFF], {
      location: () => {
        throw new Error('the environment variable FLAGS_APPLICATION_ID is not set');
      },
    });
    expect(await client.read()).toEqual({ values: {}, fromService: false });
    expect(startSession).not.toHaveBeenCalled();
    expect(warnings[0]).toMatchObject({ error: 'Error: the environment variable FLAGS_APPLICATION_ID is not set' });
  });

  it('gives up when AppConfig does not answer in time, also when the API ignores the abort signal', async () => {
    const { client, startSession, warnings } = setup([], { timeoutMs: 20 });
    startSession.mockImplementationOnce(() => new Promise<string>(() => undefined));
    const started = Date.now();
    expect(await client.read()).toEqual({ values: {}, fromService: false });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(warnings[0]?.['error']).toMatch(/did not answer in 20 ms/);
  });

  it('gives the API a signal that the client aborts at the time limit', async () => {
    const { client, startSession } = setup([OFF]);
    await client.read();
    const signal = startSession.mock.calls[0]?.[1];
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });
});

describe('flagClientFromEnv', () => {
  it('reads the three IDs from the environment of the function', async () => {
    const { api, startSession } = fakeApi([OFF]);
    const client = flagClientFromEnv(
      { FLAGS_APPLICATION_ID: 'a1', FLAGS_ENVIRONMENT_ID: 'e2', FLAGS_PROFILE_ID: 'p3' },
      { api },
    );
    await client.read();
    expect(startSession.mock.calls[0]?.[0]).toEqual({ applicationId: 'a1', environmentId: 'e2', profileId: 'p3' });
  });

  it('returns the default and a warning when an ID is missing', async () => {
    const { api, startSession } = fakeApi([OFF]);
    const warnings: string[] = [];
    const client = flagClientFromEnv({ FLAGS_APPLICATION_ID: 'a1' }, { api, warn: (line) => warnings.push(line) });
    expect(await client.read()).toEqual({ values: {}, fromService: false });
    expect(startSession).not.toHaveBeenCalled();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('FLAGS_ENVIRONMENT_ID');
  });
});

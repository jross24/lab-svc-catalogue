import { afterEach, describe, expect, it, vi } from 'vitest';

// A fake of the AWS SDK client. In Lambda the SDK comes from the runtime. The test needs no network and no credentials.
const sent: { name: string; input: Record<string, unknown>; options: unknown }[] = [];
let answers: Record<string, unknown> = {};
const clients: unknown[] = [];

vi.mock('@aws-sdk/client-appconfigdata', () => {
  class StartConfigurationSessionCommand {
    readonly name = 'StartConfigurationSession';
    readonly input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  }
  class GetLatestConfigurationCommand {
    readonly name = 'GetLatestConfiguration';
    readonly input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  }
  class AppConfigDataClient {
    constructor(config: unknown) {
      clients.push(config);
    }
    async send(command: { name: string; input: Record<string, unknown> }, options: unknown): Promise<unknown> {
      sent.push({ name: command.name, input: command.input, options });
      return answers[command.name];
    }
  }
  return { AppConfigDataClient, StartConfigurationSessionCommand, GetLatestConfigurationCommand };
});

afterEach(() => {
  sent.length = 0;
  answers = {};
  clients.length = 0;
});

const LOCATION = { applicationId: 'app1234', environmentId: 'env5678', profileId: 'prof9012' };

describe('the AppConfig data API of the AWS SDK', () => {
  it('starts a session for the application, the environment and the profile, and returns the first token', async () => {
    const { sdkAppConfigDataApi } = await import('../lib/appconfig-data.ts');
    answers = { StartConfigurationSession: { InitialConfigurationToken: 'token-one' } };
    const signal = new AbortController().signal;
    expect(await sdkAppConfigDataApi().startSession(LOCATION, signal)).toBe('token-one');
    expect(sent).toEqual([
      {
        name: 'StartConfigurationSession',
        input: {
          ApplicationIdentifier: 'app1234',
          EnvironmentIdentifier: 'env5678',
          ConfigurationProfileIdentifier: 'prof9012',
          // The cache time of the flag client is longer than this, so the client never polls too early.
          RequiredMinimumPollIntervalInSeconds: 15,
        },
        options: { abortSignal: signal },
      },
    ]);
  });

  it('gets the latest configuration, decodes the text, and returns the next token and the poll interval', async () => {
    const { sdkAppConfigDataApi } = await import('../lib/appconfig-data.ts');
    answers = {
      GetLatestConfiguration: {
        Configuration: new TextEncoder().encode('{"show-discounts":{"enabled":false}}'),
        NextPollConfigurationToken: 'token-two',
        NextPollIntervalInSeconds: 20,
      },
    };
    const signal = new AbortController().signal;
    expect(await sdkAppConfigDataApi().getLatest('token-one', signal)).toEqual({
      nextToken: 'token-two',
      content: '{"show-discounts":{"enabled":false}}',
      pollIntervalSeconds: 20,
    });
    expect(sent[0]).toMatchObject({ name: 'GetLatestConfiguration', input: { ConfigurationToken: 'token-one' } });
    expect(sent[0]?.options).toEqual({ abortSignal: signal });
  });

  it('returns empty content when AppConfig sends no configuration (nothing changed)', async () => {
    const { sdkAppConfigDataApi } = await import('../lib/appconfig-data.ts');
    answers = {
      GetLatestConfiguration: {
        Configuration: new Uint8Array(),
        NextPollConfigurationToken: 'token-three',
        NextPollIntervalInSeconds: 15,
      },
    };
    expect((await sdkAppConfigDataApi().getLatest('token-two', new AbortController().signal)).content).toBe('');
  });

  it('fails when the answer has no token, so that the flag client uses the default', async () => {
    const { sdkAppConfigDataApi } = await import('../lib/appconfig-data.ts');
    answers = { StartConfigurationSession: {}, GetLatestConfiguration: { Configuration: new Uint8Array() } };
    const api = sdkAppConfigDataApi();
    await expect(api.startSession(LOCATION, new AbortController().signal)).rejects.toThrow(/token/);
    await expect(api.getLatest('t', new AbortController().signal)).rejects.toThrow(/token/);
  });

  it('makes one client, limits the retries of the SDK, and loads the SDK only when a call needs it', async () => {
    const { sdkAppConfigDataApi } = await import('../lib/appconfig-data.ts');
    const api = sdkAppConfigDataApi();
    expect(clients).toEqual([]);
    answers = { StartConfigurationSession: { InitialConfigurationToken: 't' } };
    await api.startSession(LOCATION, new AbortController().signal);
    await api.startSession(LOCATION, new AbortController().signal);
    expect(clients).toEqual([{ maxAttempts: 2 }]);
  });
});

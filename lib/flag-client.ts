import { sdkAppConfigDataApi } from './appconfig-data.ts';

// A feature flag is on or off. A flag that the service cannot read is off: this is the safe default.
export const FLAG_DEFAULT = false;

export type FlagValues = Readonly<Record<string, boolean>>;

export interface FlagReading {
  readonly values: FlagValues;
  // True when the values came from AppConfig. False when the read failed and the values are empty (all flags default).
  readonly fromService: boolean;
}

export interface FlagClient {
  // Never rejects. A failure gives an empty reading, so every flag has its default value.
  read(): Promise<FlagReading>;
}

// The answer for one flag. A flag that the reading does not have is off.
export function isEnabled(reading: FlagReading, flag: string): boolean {
  return reading.values[flag] ?? FLAG_DEFAULT;
}

export interface FlagLocation {
  readonly applicationId: string;
  readonly environmentId: string;
  readonly profileId: string;
}

export interface LatestConfiguration {
  // The token for the next call. AppConfig gives a new one with each answer.
  readonly nextToken: string;
  // The configuration as text. It is empty when nothing changed since the last call.
  readonly content: string;
  // The least number of seconds that must pass before the next call.
  readonly pollIntervalSeconds: number;
}

// The two calls of the AppConfig data API that the client needs. lib/appconfig-data.ts has the AWS SDK version.
export interface AppConfigDataApi {
  startSession(location: FlagLocation, signal: AbortSignal): Promise<string>;
  getLatest(token: string, signal: AbortSignal): Promise<LatestConfiguration>;
}

export interface FlagClientOptions {
  readonly api: AppConfigDataApi;
  // A function, so that a missing setting is a failure of the read and not a failure of the start of the function.
  readonly location: () => FlagLocation;
  // How long a good reading lives in memory. The default is 30 seconds.
  readonly ttlMs?: number;
  // How long a failed reading lives. AppConfig gets no new call in this time. The default is 10 seconds.
  readonly failureTtlMs?: number;
  // The limit for one read (the start of a session and the request for the configuration). The default is 2 seconds.
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly warn?: (line: string) => void;
}

const TTL_MS = 30_000;
const FAILURE_TTL_MS = 10_000;
const TIMEOUT_MS = 2_000;

function writeToStdout(line: string): void {
  process.stdout.write(`${line}\n`);
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

// The content of a feature-flag profile, as AppConfig sends it to a client: {"flag-key":{"enabled":true}}.
// An entry with no boolean "enabled" is ignored, so that flag has its default. Content that is not a JSON object
// is an error, because it means that something is wrong with the profile.
function parseContent(content: string): FlagValues {
  const parsed: unknown = JSON.parse(content);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('the flag content is not a JSON object');
  }
  const values: Record<string, boolean> = {};
  for (const [name, entry] of Object.entries(parsed)) {
    const enabled: unknown = typeof entry === 'object' && entry !== null ? (entry as { enabled?: unknown }).enabled : undefined;
    if (typeof enabled === 'boolean') values[name] = enabled;
  }
  return values;
}

// Runs the work with a time limit. The signal tells the SDK to stop. The race makes sure that the limit holds
// also when the work ignores the signal.
async function withTimeout<T>(limitMs: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`the flag service did not answer in ${limitMs} ms`));
    }, limitMs);
  });
  try {
    return await Promise.race([work(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}

// Reads the flags of the service with the AppConfig data API, and keeps them in memory for a short time.
//
// The API works with a session. StartConfigurationSession gives a token. Each GetLatestConfiguration call takes the
// token and gives the configuration and a new token. When nothing changed, the configuration is empty, and the client
// keeps the flags that it has. The token lives in this client, so it lives as long as the Lambda environment.
//
// A failure never reaches the caller. The client then returns an empty reading, so each flag is off, and it writes one
// warning. It forgets the session, so the next read starts a new one. For a short time it asks AppConfig nothing,
// so a flag outage does not make each request wait for a timeout.
export function createFlagClient(options: FlagClientOptions): FlagClient {
  const now = options.now ?? ((): number => Date.now());
  const warn = options.warn ?? writeToStdout;
  const ttlMs = options.ttlMs ?? TTL_MS;
  const failureTtlMs = options.failureTtlMs ?? FAILURE_TTL_MS;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;

  let token: string | undefined;
  let lastValues: FlagValues = {};
  let cached: { readonly reading: FlagReading; readonly expiresAt: number } | undefined;
  let pending: Promise<FlagReading> | undefined;

  async function fetchLatest(): Promise<{ reading: FlagReading; ttl: number }> {
    try {
      const location = options.location();
      const { content, nextToken, pollIntervalSeconds } = await withTimeout(timeoutMs, async (signal) => {
        token ??= await options.api.startSession(location, signal);
        return options.api.getLatest(token, signal);
      });
      token = nextToken;
      if (content !== '') lastValues = parseContent(content);
      return {
        reading: { values: lastValues, fromService: true },
        // AppConfig can ask for a longer wait than the cache time. The client then waits that long.
        ttl: Math.max(ttlMs, pollIntervalSeconds * 1000),
      };
    } catch (error) {
      token = undefined;
      lastValues = {};
      warn(
        JSON.stringify({
          timestamp: new Date(now()).toISOString(),
          level: 'WARN',
          event: 'flag-read-failed',
          message: 'The flag service did not give the flags. Every flag has its default value (off).',
          error: describeError(error),
        }),
      );
      return { reading: { values: {}, fromService: false }, ttl: failureTtlMs };
    }
  }

  async function refresh(): Promise<FlagReading> {
    const { reading, ttl } = await fetchLatest();
    cached = { reading, expiresAt: now() + ttl };
    return reading;
  }

  return {
    read(): Promise<FlagReading> {
      if (cached !== undefined && now() < cached.expiresAt) return Promise.resolve(cached.reading);
      // Reads that run at the same time share one call.
      pending ??= refresh().finally(() => {
        pending = undefined;
      });
      return pending;
    },
  };
}

function requiredSetting(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`the environment variable ${name} is not set`);
  return value;
}

// The client of the function. The stack sets the three IDs. It reads them from the SSM parameters of lab-flags at deployment.
export function flagClientFromEnv(
  env: Record<string, string | undefined> = process.env,
  options: Partial<FlagClientOptions> = {},
): FlagClient {
  return createFlagClient({
    api: sdkAppConfigDataApi(),
    location: () => ({
      applicationId: requiredSetting(env, 'FLAGS_APPLICATION_ID'),
      environmentId: requiredSetting(env, 'FLAGS_ENVIRONMENT_ID'),
      profileId: requiredSetting(env, 'FLAGS_PROFILE_ID'),
    }),
    ...options,
  });
}

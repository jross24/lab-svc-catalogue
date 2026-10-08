import type { AppConfigDataApi, FlagLocation, LatestConfiguration } from './flag-client.ts';

// The AWS SDK for JavaScript v3 is a part of the Node.js 22 runtime of Lambda, so the bundle does not contain it.
// The NodejsFunction construct marks every @aws-sdk/* package as external by default, and esbuild leaves the import
// as it is. The package is a dev dependency of this repository only for its types and for the tests.
// The import is lazy. A request pays for the load of the SDK when the first flag read needs it, and that read runs
// at the same time as the call to core.

// A session asks for 15 seconds, the least that AppConfig allows. The flag client caches for 30 seconds, so it never
// calls before the end of that time.
const MIN_POLL_INTERVAL_SECONDS = 15;

// One retry at most. The flag client also has a time limit, and a flag outage must not slow a request.
const MAX_ATTEMPTS = 2;

type Sdk = typeof import('@aws-sdk/client-appconfigdata');

export function sdkAppConfigDataApi(): AppConfigDataApi {
  let loaded: Promise<{ sdk: Sdk; client: InstanceType<Sdk['AppConfigDataClient']> }> | undefined;

  // The Lambda runtime sets the region and the credentials in the environment, and the SDK reads them from there.
  function load(): Promise<{ sdk: Sdk; client: InstanceType<Sdk['AppConfigDataClient']> }> {
    loaded ??= import('@aws-sdk/client-appconfigdata').then((sdk) => ({
      sdk,
      client: new sdk.AppConfigDataClient({ maxAttempts: MAX_ATTEMPTS }),
    }));
    // A failed load (for example, a runtime without the package) must be tried again by the next read.
    loaded.catch(() => {
      loaded = undefined;
    });
    return loaded;
  }

  return {
    async startSession(location: FlagLocation, signal: AbortSignal): Promise<string> {
      const { sdk, client } = await load();
      const answer = await client.send(
        new sdk.StartConfigurationSessionCommand({
          ApplicationIdentifier: location.applicationId,
          EnvironmentIdentifier: location.environmentId,
          ConfigurationProfileIdentifier: location.profileId,
          RequiredMinimumPollIntervalInSeconds: MIN_POLL_INTERVAL_SECONDS,
        }),
        { abortSignal: signal },
      );
      if (!answer.InitialConfigurationToken) throw new Error('AppConfig gave no session token');
      return answer.InitialConfigurationToken;
    },

    async getLatest(token: string, signal: AbortSignal): Promise<LatestConfiguration> {
      const { sdk, client } = await load();
      const answer = await client.send(new sdk.GetLatestConfigurationCommand({ ConfigurationToken: token }), {
        abortSignal: signal,
      });
      if (!answer.NextPollConfigurationToken) throw new Error('AppConfig gave no token for the next call');
      return {
        nextToken: answer.NextPollConfigurationToken,
        // An empty configuration means that nothing changed.
        content: new TextDecoder().decode(answer.Configuration ?? new Uint8Array()),
        pollIntervalSeconds: answer.NextPollIntervalInSeconds ?? MIN_POLL_INTERVAL_SECONDS,
      };
    },
  };
}

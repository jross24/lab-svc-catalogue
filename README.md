# lab-svc-catalogue

This repository holds the mock "catalogue" service of the pipeline lab.
It is an AWS CDK app in TypeScript. The pipeline in [lab-workflows](https://github.com/jross24/lab-workflows) releases it.

The service has the same shape as [lab-svc-core](https://github.com/jross24/lab-svc-core), and it uses the same release and observability pattern.
This README explains what is different. The lab-svc-core README explains the shared mechanics in more detail:
[Gradual release](https://github.com/jross24/lab-svc-core#gradual-release), [Observability](https://github.com/jross24/lab-svc-core#observability),
[Tracing](https://github.com/jross24/lab-svc-core#tracing) and [The Production drill](https://github.com/jross24/lab-svc-core#the-production-drill).

## What the service is

The service is one Lambda function behind an API Gateway HTTP API.
The API is public. It has one route, `GET /products`, with no authoriser.

The function calls the private API of the core service. Then it returns JSON:

```json
{
  "service": "catalogue",
  "version": "0.1.0",
  "core": { "version": "0.1.0", "itemCount": 3 },
  "products": [{ "id": "product-1", "name": "First product", "price": 10 }]
}
```

The `version` field shows which release of this service runs.
The `core` block shows the version of core and the number of items that core returned.
So one request proves that the chain works: the public API, this function, the private API, the core function.

If the call to core fails, the route returns HTTP 502 with a JSON error. It does not hide the failure:

```json
{
  "service": "catalogue",
  "version": "0.1.0",
  "error": "The call to the core service failed.",
  "cause": "core returned HTTP 403"
}
```

The response does not copy the error body of core, because that body can name an IAM role and an account.
The log of the function has the full error. The metric line counts the 502 as an error. See "What an error means here".

## How the service finds and calls core

The core stack writes two SSM parameters in each account where it runs.

| Parameter | How this service uses it |
| --- | --- |
| `/lab/core/url` | The stack gives it to the function as the environment variable `CORE_URL`. |
| `/lab/core/api-arn` | The stack allows the function role `execute-api:Invoke` on exactly this ARN. |

CloudFormation reads the two parameters at deployment. The CDK does not read them at synth.
So the templates name no account, and one `cdk synth` still serves each account.
If core gets a new value for one of them, this service keeps the old value until its next deployment. The deploy job of core warns about it and names the `redeploy` workflow of this service (see "Provider parameters" in lab-workflows).

The API of core uses IAM authorisation. So the function signs each request with AWS Signature Version 4.
It signs with the temporary credentials of its own role. The Lambda runtime puts them in environment variables.
The file `lib/sign.ts` does the signing with `@smithy/signature-v4` and `@aws-crypto/sha256-js`. esbuild bundles both into the function.
After the signing, the call gets the header `traceparent`, which carries the trace on to core. See "Tracing".

The stack also writes its own address for the web application of a later phase. It writes its own version too.

| Parameter | Value |
| --- | --- |
| `/lab/catalogue/url` | The base URL of this API. Add `/products` to call the route. |
| `/lab/catalogue/version` | The version of catalogue that the stack runs. The release workflow of lab-workflows reads it, to check the deployment order and the set of tested versions. |

A `Dev` copy with a namespace writes `/lab/ns/<ns>/catalogue/url` and `/lab/ns/<ns>/catalogue/version`. It does not write the two parameters above. It reads the same two core parameters as the other copies.
See "Namespaces".

## Deployment order: core and lab-flags first

Deploy core and lab-flags to an account before you deploy this service to that account.

CloudFormation reads `/lab/core/url` and `/lab/core/api-arn` when it deploys this stack.
If core is not in the account, the parameters do not exist, and the deployment fails before it creates a resource.
CloudFormation also reads `/lab/flags/application-id`, `/lab/flags/environment-id` and `/lab/flags/profile-id` when it deploys this stack.
A `Dev` copy reads the same three parameters, so its account needs the baseline copy of lab-flags.
The file `pipeline.json` names the services that this service needs: `core >=0.5.0` and `flags >=0.1.0`.
Before each deploy job changes an environment, the pipeline reads `/lab/core/version` and `/lab/flags/version` in that environment.
It stops the job with a clear message if one of them is not there, or if its version is outside the range. The job fails before CloudFormation starts, so it changes nothing.
The pipeline also compares the set of versions that passed in Test with the environment. This service has no range for web and account, so an environment must run at
least the versions that the E2E suite tested. The README of [lab-workflows](https://github.com/jross24/lab-workflows) explains both checks.

CloudFormation reads the parameters again at each deployment of this stack.
If core gets a new URL, release or redeploy this service to pick it up.

## Stages

One `cdk synth` makes three CDK stages: `Test`, `Staging` and `Production`.
Each stage holds one stack, `lab-svc-catalogue`. The file `lib/stages.ts` holds the settings that differ between stages.

| Setting | Test | Staging | Production |
| --- | --- | --- | --- |
| `logRetentionDays` | 7 | 7 | 30 |
| `release` | all at once | all at once | canary: 10 percent, then 100 percent after 5 minutes |
| `injectFault` | false | false | false |
| `allowFlagOverride` | true | false | false |
| `traceSampleRatio` | 1 | 1 | 1 |

Every stage has the same resources: the same alias, the same CodeDeploy deployment group, the same three alarms and the same dashboard.
Only the values in the table differ. A unit test compares the three templates to check this.
`injectFault` is a device for the release drill. See "The Production drill". No stage sets it in `main`.
`allowFlagOverride` lets a request header override a feature flag. Only Test and Dev allow it. See "Feature flags".
`traceSampleRatio` is the share of new traces that are sampled. See "The export stays on the request path, and the sampling ratio" in the Tracing section.

The code names no AWS account and no region. A stack goes to the account of the credentials that deploy it.
All three stages use the same bundled Lambda code.

## Gradual release and observability

This service follows the pattern of lab-svc-core. The core README explains how each part works.
This section shows what is the same, what is different, and the numbers that belong to this service.

### What is the same as core

- The alias `live`. The API calls the alias, and not the function. The route, the API and the parameter `/lab/catalogue/url` do not change, so the web application needs no change.
- The CodeDeploy deployment group. Test and Staging release all at once. Production releases a canary: 10 percent of the traffic for 5 minutes, then all of it.
- The alarms `ErrorsAlarm` and `LatencyAlarm`. CodeDeploy reads them during a deployment and rolls the release back when one fires.
- One JSON log line and one metric line (embedded metric format) for each request, with the service name `catalogue`. One dashboard, `lab-svc-catalogue`.
- Tracing with OpenTelemetry. The function sends its spans to the OTLP endpoint of X-Ray. Lambda active tracing is off. See "Tracing".
- The fault switch `injectFault` and the drill. The log retention of each stage.
- The shared files are pinned copies of `shared/` in lab-workflows: 9 files in `lib/`, 7 tests and `test/support/contract-schema.ts`. `shared.lock.json` names the commit, and the job `shared` of the pull request check fails when a copy is not byte-equal to that commit. To change a shared file, change it in lab-workflows, then run `node actions/shared-files/sync.mjs <path to this repository>` in a clone of lab-workflows (see the section "Shared files" of its README).

### What is different from core

- **A third alarm.** `ServiceErrorsAlarm` reads the metric `errors` of the version that the stack deploys. The next section explains why.
- **Other numbers.** The latency threshold is 3000 ms and the function timeout is 10 seconds. Core uses 500 ms and 3 seconds.
- **A public route.** The route has no authoriser. The route of core uses IAM authorisation.
- **The call to core.** The function signs a request to core. The SSM parameter `/lab/catalogue/url`, the variable `CORE_URL` and the `execute-api:Invoke` policy do not change.
  The alias runs with the same role as the function, so the policy needs no new statement for the alias.
- **A client span for the call to core.** `lib/core-client.ts` sends the call through `tracing.fetch`. Core calls no other service, so its code has no client span.
- **One more graph** on the dashboard: "Errors that the service counted, by version".

### What an error means here

Core throws when it fails. Catalogue does not. When the call to core fails, the handler catches the error and returns HTTP 502.
The function returns a normal result, so Lambda does not count the call as an error. The Lambda `Errors` metric stays at 0.
So `ErrorsAlarm` cannot see a new version that cannot call core. For example, a new version can get `403` from core because a permission is missing.

The wrapper in `lib/instrument.ts` closes the gap. It counts a status of 500 or more as an error in the metric `errors`.
`ServiceErrorsAlarm` fires on one error or more in a period of 1 minute. It reads the metric of the version that the stack deploys.
During a canary it sees the new version only. Errors of the old version do not count. CodeDeploy reads this alarm too and rolls the release back.

If core is down during a release, the new version also counts errors, and the release rolls back. This is correct: the release cannot prove that it works.

A unit test proves the metric part with the real handler and a fake core. The fake core answers `403`, `500`, a bad body, or a network failure.
In each case the handler returns 502 and does not throw. The log line has the level `ERROR`, and the metric line has `errors` = 1.

The tests are in `test/products-handler.test.ts`.

**What the lab saw in lab-dev.** The lab ran this case in its own account `lab-dev` on 2026-10-08, with this code.
The `Dev` stage got the canary configuration and a wrong path in `CORE_URL`, for this test only. The test did not change `main`.
So core did not answer 200 to any call of the new version, and the function answered 502 without a throw. A loop sent a request to `GET /products` every 2 seconds. The times are UTC.

| Time | What happened |
| --- | --- |
| 00:21:11 | The deployment started, with the configuration `CodeDeployDefault.LambdaCanary10Percent5Minutes`. |
| 00:21:24 | The first call of the new version answered 502. |
| 00:22:52 | CodeDeploy stopped the deployment: state `Stopped`, error code `ALARM_ACTIVE`. The message of `cdk deploy` named `ServiceErrorsAlarm`. |
| 00:22:53 to 00:22:55 | CodeDeploy ran the rollback deployment with `CodeDeployDefault.LambdaAllAtOnce`. It was `Succeeded`. |
| after | The stack was `UPDATE_ROLLBACK_COMPLETE`, and `cdk deploy` failed. |

`ErrorsAlarm` stayed in the state `OK` the whole time, because Lambda counted no error. Only `ServiceErrorsAlarm` saw the failure. Of 245 calls, 4 answered 502.
The rollback was complete 101 seconds after the start.

### Where the latency threshold comes from

The alarm `LatencyAlarm` fires when the p99 duration of the alias is over 3000 ms in 2 periods of 1 minute in a row.
The duration of this function includes the signed call to core. That adds one HTTPS round trip to each request.
When core is cold, the call also waits for the init time of core.

The lab measured the duration in Test and Production on 2026-10-07. The window is the 24 hours up to 22:05 UTC.
The services are new, so the first request was at 18:42 UTC in Test and at 20:11 UTC in Production.

The numbers come from the `REPORT` lines of the function log. The sample includes 35 requests that the lab sent to the public API (25 in Test, 10 in Production).

| Stage | Requests | Warm p50 | Warm p99 | Cold request, core warm | Cold request, core cold |
| --- | --- | --- | --- | --- | --- |
| Test | 119 (108 warm, 11 cold) | 77 ms | 960 ms | 1632 to 1657 ms (5 requests) | 1902 to 1982 ms (6 requests) |
| Production | 23 (19 warm, 4 cold) | 98 ms | 1001 ms | 1657 ms (1 request) | 1806 to 2074 ms (3 requests) |

The CloudWatch metric `Duration` counts all requests, cold ones too. In Test it gave p50 123 ms and p99 1957 ms.
In Production it gave p50 180 ms and p99 2069 ms. The init time of the function is 140 to 200 ms. Lambda reports it apart from `Duration`, so the alarm does not see it.

What the numbers show:

- Most warm requests (85 percent) take 20 to 300 ms. The slow warm requests (0.4 to 1.5 s) come in the first minutes of a new environment, or after a pause of several minutes.
- A cold request takes 1.6 to 2.1 s. A cold core adds about 0.3 s to it.
- The samples are small. The warm p99 is the second-slowest request of 108 in Test, and the slowest request of 19 in Production. Read it as "about 1 second".

The choice is **3000 ms**:

- It is 3 times the warm p99 (about 1 second).
- It is above the slowest cold request (2074 ms). So the cold start of a new version cannot fire the alarm alone. The alarm also needs 2 minutes in a row.
- It is below a third of the function timeout (10 seconds). A third is 3333 ms.
- A real fault still fires it. The client in `lib/core-client.ts` waits 5 seconds for core, so a core that does not answer gives a duration of about 5 seconds.

A unit test keeps the value above 2074 ms and at or below a third of the timeout.
**After the tracing change (512 MB, OpenTelemetry).** The lab deployed the four services to its own account `lab-dev` on 2026-10-07 and loaded the web page.
The first request of catalogue after a deployment (the whole chain cold) took 1.2 to 1.3 s. A warm request took 124 ms (median). Core took 0.45 to 0.47 s for its first request.
The value 3000 ms stays. It is above the first request, so a cold start does not fire the alarm. A core that hangs makes this function wait 5 s (the limit of its call to core), so a real fault fires it.
The core README has the full table for 128, 256, 512 and 1024 MB.

Change the value when the lab has more traffic. Look at the graph "Duration of the alias live" on the dashboard.

### The first release makes the alias

CodeDeploy needs an old version to move traffic from. When the alias does not exist, CloudFormation creates it and starts no deployment.
So **the first release with this change goes to each stage with no canary**.

The second release is the first gradual release. Do not redeploy `0.1.0` or `0.1.1` with the `redeploy` workflow.
Those releases have no alias, so a redeploy removes the alias, the deployment group, the alarms and the dashboard.

The first release also moves the API from the function to the alias. The invoke permission of the alias must exist before the integration calls the alias, so the API stays up.
The stack makes each integration depend on each invoke permission of the API. A unit test checks this.

## Tracing

The service traces its requests with OpenTelemetry. A request through the web application gives one trace across web, this service and core.
The decision, the measurements and the trade-off are in the [Tracing section of the lab-svc-core README](https://github.com/jross24/lab-svc-core#tracing).
This section shows what is specific to this service.

### The export stays on the request path, and the sampling ratio

The owner decided that the export of the spans stays on the request path, with 512 MB of memory ([lab-platform#28](https://github.com/jross24/lab-platform/issues/28)).
The answer of a request waits for one signed call to X-Ray. At 512 MB this costs about 35 ms for a warm request, and about 450 ms for the first request of a new environment.
The lab accepts this cost, because the other ways cost more than they give here. The cost table for 128 to 1024 MB is in the [Tracing section of the lab-svc-core README](https://github.com/jross24/lab-svc-core#tracing).

What changed is the sampling. A request that is not sampled makes no call to X-Ray, so it does not pay the cost.

**How to set the ratio.** `traceSampleRatio` in `lib/stages.ts` is a number from 0 to 1 for each stage. The value 1 samples all requests, and every stage has it today.
`lib/catalogue-stack.ts` writes the number into the variable `TRACE_SAMPLE_RATIO` of the function (`tracingEnvironment` in `lib/function-defaults.ts`). `lib/tracing.ts` reads it.
To change the ratio, edit the number and open a pull request. The pipeline deploys it like any other change. A number outside 0 to 1 stops `cdk synth`.

The sampler is parent based. A request with a `traceparent` header follows its caller: a sampled parent is always followed, and a parent that is not sampled never is.
A request with no parent is sampled by its trace ID, for the share that the ratio names. Web starts the trace of a page request and sends `traceparent`, so this service follows the decision of web. Its own ratio applies only to a request that comes with no `traceparent` header, for example a direct call.
The log line keeps the trace ID of a request that is not sampled, but X-Ray then has no trace for this ID.
The unit tests in `test/tracing.test.ts` prove the rules: ratio 0 gives no call to the exporter, and ratio 1 gives one.

### What the service records

- **One server span for each request.** The wrapper in `lib/instrument.ts` makes it. The name is the route key, `GET /products`.
  The span has the method, the path, the status code, the request ID and the cold start flag.
  A status of 500 or more, a thrown error and a degraded answer mark the span as an error.
- **One client span for each call to core.** `lib/core-client.ts` makes it. The name is `GET <host of core>`.
  The span has the method, the host, the URL without the query, and the status code.
  A status of 400 or more, or a failed request, marks it as an error. The span never holds the body of the answer.

The client span is a child of the server span. The server span is a child of the span of the caller, when the caller sends the header `traceparent`.

### How the trace crosses to core

The function signs the request to core first. Then `tracing.fetch` adds the header `traceparent` to the signed headers.
The signature lists only `host` and the `x-amz-*` headers. So the extra header does not break the signature, and API Gateway accepts the request.
The service does not use the header `X-Amzn-Trace-Id`. API Gateway adds a part of its own to that header, and Lambda ignores it for its own trace. The core README shows the test.

Unit tests in `test/core-client.test.ts` check four facts:

- The signed headers stay the same, and `traceparent` is the only new header.
- The list `SignedHeaders` has no `traceparent` and no `x-amzn-trace-id`.
- The client span is a child of the server span, and it has the ID that `traceparent` carries.
- A request outside of a server span gets no new header.

### Where the spans go

The function sends the spans of a request to the OTLP endpoint of X-Ray (`https://xray.<region>.amazonaws.com/v1/traces`) when the request ends.
The request is signed with AWS Signature Version 4 for the service `xray`. `lib/sigv4.ts` does this signing, and `lib/sign.ts` still signs the call to core.
A failed export never fails a request. The function writes one `WARN` line to the log.

The endpoint works only when CloudWatch Transaction Search is on in the account. The stack of core turns it on. This stack does not touch it.
The variable `TRACING=off` switches tracing off. Outside Lambda, tracing is off.

### What the stack changes

- **One more IAM statement.** The function role gets `xray:PutTraceSegments` on the resource `*`. X-Ray actions do not support a resource. It is the only X-Ray action.
- **No active tracing.** The function has no `TracingConfig`. Active tracing would make a second trace for each call, with another trace ID.
- **No Lambda layer.** esbuild bundles the OpenTelemetry packages into the function.
- **512 MB of memory.** `FUNCTION_MEMORY_MB` in `lib/function-defaults.ts` sets it. Lambda gives CPU in proportion to memory. The core README has the measurements.
- **An ES module.** `FUNCTION_BUNDLING` makes esbuild build `index.mjs` from the `module` entry of each package. So esbuild removes the code that no request uses.
  A unit test checks that `index.mjs` exists, that `index.js` does not exist, and that `index.mjs` is below 200 KB.

### How to find a trace

Take `traceId` from a log line of the function. It has the form of X-Ray: `1-xxxxxxxx-yyyyyyyyyyyyyyyyyyyyyyyy`. Then run:

```
aws xray batch-get-traces --trace-ids <traceId> --profile <read-only-profile>
```

The log line and the spans carry the same trace ID. A trace that starts in the web application also holds the spans of web and core.

## Feature flags

The flag `show-discounts` decides whether `GET /products` shows a discount.
The flag lives in [lab-flags](https://github.com/jross24/lab-flags). It is off in every stage.

When the flag is on, each product has one more field, `discount`. The value is a mock: 10, which means 10 percent.
When the flag is off, the answer is the same as before the flag existed. The field `discount` is optional in `contract.json`, so adding it is an additive change.

### How the service reads the flags

The stack reads three SSM parameters of lab-flags at deployment: `/lab/flags/application-id`, `/lab/flags/environment-id` and `/lab/flags/profile-id`.
It passes them to the function as the environment variables `FLAGS_APPLICATION_ID`, `FLAGS_ENVIRONMENT_ID` and `FLAGS_PROFILE_ID`.
The role of the function may call only `appconfig:StartConfigurationSession` and `appconfig:GetLatestConfiguration`, and only on that one configuration.

The file `lib/flag-client.ts` reads the flags with the AppConfig data API:

1. It starts a session with `StartConfigurationSession` and keeps the session token.
2. It calls `GetLatestConfiguration` with the token. AppConfig answers with the flags, for example `{"show-discounts":{"enabled":false}}`, and a new token.
3. When nothing changed since the last call, AppConfig sends no content. The client then keeps the flags that it has.

The client keeps the flags in memory for 30 seconds. A Lambda environment calls AppConfig at most once in 30 seconds, and a flag change reaches a request in about that time.
The read starts at the same time as the call to core, so it adds little time to a request.

The AWS SDK client comes with the Node.js 22 runtime of Lambda. The construct `NodejsFunction` marks `@aws-sdk/*` as external, so esbuild does not put it in the bundle.
The package `@aws-sdk/client-appconfigdata` is a dev dependency of this repository. It gives the types and lets the unit tests load the module. The function loads the SDK at its first flag read.

### The safe default: off

A flag service outage must never fail a request. Any failure to read gives the default value, and the default is off.
A failure is, for example, a missing permission, a timeout (the limit is 2 seconds), content that is not JSON, or a missing environment variable.

After a failure the client does the following:

- It writes one warning line, for example `{"level":"WARN","event":"flag-read-failed","error":"..."}`.
- It returns the default for every flag. A flag that was on goes back to off, because the service cannot know its value.
- It starts a new session at the next read, and it makes no call for 10 seconds, so a request does not wait for a timeout each time.

An unknown flag is also off. A flag that the content lists with no boolean `enabled` is also off.

The log line of each request shows what the request used:

| Field | Meaning |
| --- | --- |
| `flags` | The effective value of each flag, for example `{"show-discounts":false}`. |
| `flagsSource` | `appconfig` when the values came from AppConfig. `default` when the read failed. |
| `flagsOverridden` | `true` when the request header set the flag for this request. |

### The override header: Test only

A test needs both states of the flag, and the flag is off everywhere. So a stage can allow a request header that overrides the flag for that one request.
The stage setting `allowFlagOverride` controls it. The value is `true` for Test and Dev, and `false` for Staging and Production.

Where the setting is `true`, the stack sets the environment variable `ALLOW_FLAG_OVERRIDE`. The header `x-lab-flags` then sets the flag:

```bash
curl -s -H 'x-lab-flags: show-discounts=on' "$TEST_URL/products"    # the products have a discount
curl -s -H 'x-lab-flags: show-discounts=off' "$TEST_URL/products"   # the products have no discount
```

- A header with several flags uses commas: `a=on,b=off`. The service reads only `show-discounts`.
- A part that is malformed is ignored, and the flag keeps its value. Examples are `show-discounts`, `show-discounts=yes` and `show-discounts==on`.
- Where the setting is `false`, the stack does not set `ALLOW_FLAG_OVERRIDE`, and the handler ignores the header. Production answers the same with and without the header.
- The header changes one request only. The next request without the header uses the flag from AppConfig.

Unit tests check both cases, and a synth test checks that only the Test template has `ALLOW_FLAG_OVERRIDE`.

## The Production drill

The method is in the core README, section [The Production drill](https://github.com/jross24/lab-svc-core#the-production-drill). For this service:

1. In `lib/stages.ts`, set `injectFault: true` in the `Production` block.
2. In `test/app.test.ts`, change `DRILL_STAGES` to `['Production']`. The guard test fails if you change only one of the two files.
3. Merge the pull request with the title `fix: drill, inject a fault in production`. The release passes Test and Staging. Approve it in Production.
4. Send traffic to `GET /products` with the loop from the core README. The faulty version gets 10 percent of it. The function throws, so `ErrorsAlarm` fires and CodeDeploy rolls the release back.
5. Clean up with a second pull request that sets both values back. Give it the title `fix: remove the drill fault`.

A dry run with exactly these two edits passed lint, typecheck, all the tests and `cdk synth`. `INJECT_FAULT` appeared only in the Production template.
The lab did not run this drill in Production: the owner runs it. It ran the 502 case in its own account (see "What an error means here").

With only the edit in `lib/stages.ts`, the guard test fails, as it should. The switch makes the function throw, so the drill tests `ErrorsAlarm` and not `ServiceErrorsAlarm`.
The unit tests in "What an error means here" and the run in `lab-dev` cover the third alarm.

## How a change reaches Production

1. Open a pull request. The `pr` workflow runs lint, typecheck, the tests and `cdk synth`. It also scans the dependencies and the commits for secrets, and it checks the workflow files. It compares the two contract files with Production (see "The contract files"). It posts the `cdk diff` against Production as one comment. A delete or a replacement of a stateful resource fails the check until someone adds the label `destructive-change-approved`. The [README of lab-workflows](https://github.com/jross24/lab-workflows#the-cdk-diff-comment) explains the comment.
2. Merge the pull request with a squash. The `release` workflow starts.
3. The workflow works out the next version from the commit title and creates the tag, for example `v0.2.0`.
4. The workflow builds one time and stores the zipped `cdk.out` in a GitHub release.
5. The workflow takes the lock of Test. It checks the deployment order, deploys that same zip to Test, and runs the end-to-end suite. The suite also checks that Test reports the version of the release. The workflow records the four versions that passed as `tested-with.json` on the GitHub release.
6. The workflow checks the order and the tested set again in Staging, deploys the zip there, and runs the smoke subset of the suite. CodeDeploy moves the traffic at once in Test and in Staging.
7. The workflow waits. A reviewer approves the `production` environment in GitHub. A newer release that reaches this point cancels an older release that still waits. After the approval the workflow checks again, deploys the same zip to Production, and runs the smoke subset. CodeDeploy moves 10 percent of the traffic, waits 5 minutes, and moves the rest.
   If the smoke subset fails, the job fails and a redeploy of the earlier version waits for the reviewer.

The README of [lab-workflows](https://github.com/jross24/lab-workflows) explains each step.

A title that starts with `feat:` gives a minor version. A title with `!` before the colon gives a major version. Any other title gives a patch version.

To go back to an old version, run the `redeploy` workflow. It deploys the stored zip of that release and does not build.

```
gh workflow run redeploy.yml -f version=0.1.0 -f environment=test
```

The directory `.github/workflows/` has four files.
`pr.yml`, `release.yml` and `redeploy.yml` are byte-for-byte copies of the files in lab-svc-core. `preview.yml` belongs to this repository, and core has no such file.
It deploys the preview of a pull request (see "The preview of a pull request"). This repository has no other pipeline code.

## The contract files

The file `contract.json` says what `GET /products` promises to the web application, and `expectations.json` says which fields of core this service reads.
The service reads only `version` and the number of `items`, so it reads neither `name` nor `title` of an item.
On each pull request, the job `pr / contracts` compares both files with the releases that run in Production. See [Contract tests](https://github.com/jross24/lab-workflows#contract-tests) in the README of lab-workflows.
It fails a pull request that removes a field a neighbour still reads, or that needs a field Production does not have yet.

## Run the checks locally

You need Node.js 22.18 or later. Node.js runs the TypeScript files directly, so there is no build step.
esbuild bundles the Lambda code into one ES module, `index.mjs`, during `cdk synth`. You do not need Docker.

```
npm ci
npm run lint
npm run typecheck
npm test
npm run synth
```

The tests and the synthesis do not need AWS credentials or a network.

## Deploy to a personal account

Do not deploy `Test`, `Staging` or `Production` from a laptop. Only the pipeline deploys them.

For your own experiments there is a fourth stage, `Dev`. The context value `dev=true` selects it.
With `dev=true` the app makes only the `Dev` stage, so the command cannot touch a pipeline stage by accident.

```
npx cdk deploy -c dev=true "Dev/*" --profile <your-dev-profile>
npx cdk destroy -c dev=true "Dev/*" --profile <your-dev-profile>
```

The deployment-order rule applies here too. Deploy the `Dev` stage of lab-svc-core to the account first.
The `Dev` stage has the alias, the deployment group, the alarms and the dashboard too. It releases all at once.

With no other context value, the `Dev` stage is the **baseline copy** of the account. It uses the fixed names of the table below.
The web application of the account reads `/lab/catalogue/url`, so the baseline copy is the copy that it calls.
An account holds one baseline copy, and it stays deployed. To run a second copy, use a namespace.

### Namespaces

A namespace gives a copy of the `Dev` stage names of its own. So a second copy can live in the same account and not touch the baseline copy.
Use it for a copy on your laptop. The pipeline uses it for the preview of a pull request.

```
npx cdk deploy -c dev=true -c namespace=my-test -c version=0.0.0-my-test "Dev/*" --profile <your-dev-profile>
npx cdk destroy -c dev=true -c namespace=my-test "Dev/*" --profile <your-dev-profile>
```

The rules for the context value `namespace`:

- It is valid only together with `dev=true`. With `dev` off, the app stops with an error.
- It has 1 to 20 characters. The first character is a letter from `a` to `z`.
- The other characters are the letters `a` to `z`, the digits `0` to `9` and `-`. The last character is not `-`.
- The app stops with an error for any other value. The message shows the value and an example.
- The pipeline stages never read it.

The names that the namespace changes:

| | No namespace (baseline copy) | Namespace `<ns>` | Example, namespace `pr-12` |
| --- | --- | --- | --- |
| Stack name | `lab-svc-catalogue` | `lab-svc-catalogue-<ns>` | `lab-svc-catalogue-pr-12` |
| SSM parameter with the URL | `/lab/catalogue/url` | `/lab/ns/<ns>/catalogue/url` | `/lab/ns/pr-12/catalogue/url` |
| SSM parameter with the version | `/lab/catalogue/version` | `/lab/ns/<ns>/catalogue/version` | `/lab/ns/pr-12/catalogue/version` |
| Dashboard name | `lab-svc-catalogue` | `lab-svc-catalogue-<ns>` | `lab-svc-catalogue-pr-12` |
| Tag on the stack and its resources | none | `lab-namespace=<ns>` | `lab-namespace=pr-12` |

Nothing else of the stack has a fixed name. CloudFormation builds the other names from the stack name, so they are unique too.
This holds for the function, the log group, the role, the alarms and the CodeDeploy application.
The alias `live` belongs to one function, so it is the same in each copy. The stack has no output with an export name.
A unit test compares all Name-like properties of two namespaces. It fails when a new fixed name appears.

The code is in `lib/namespace.ts`. It does not change the nine shared files.
The shared dashboard code always names the dashboard `lab-svc-catalogue`. So the stack sets the new name on the `CfnDashboard` with `addPropertyOverride`.
The property `dashboardName` of the construct keeps the old value. Nothing reads it.

**The reserved prefix.** The namespace `pr-<number>`, for example `pr-12`, belongs to the pipeline.
The pipeline deploys the preview of a pull request under that name and deletes it when the pull request closes.
Do not use a name that starts with `pr-` on a laptop.

**How a laptop copy and a preview live together.** Each copy has its own stack, URL parameter and dashboard.
So the baseline copy, the laptop copy `my-test` and the preview `pr-12` can run together in one account.
`cdk destroy` of a namespace deletes only the stack with that namespace in its name.

**Core.** A copy with a namespace still reads `/lab/core/url` and `/lab/core/api-arn`. So it calls the baseline copy of core.
Deploy the baseline copy of core first. A preview of this service finds core in the long-lived baseline of the account.
Core has no namespace yet. When it has one, a context value `coreNamespace` can point this service at a preview of core. This service does not have that value yet.

**The version.** Give each copy its own `version`. The version is a dimension of the metrics `requests` and `errors`.
`ServiceErrorsAlarm` reads the dimension. Two copies with the same version share their metric lines. So the alarm of one copy can fire on the errors of the other.
The pipeline uses a version such as `0.0.0-pr12.abc1234`. The default `0.0.0-dev` belongs to the baseline copy.

**The dashboard.** The graphs "Requests by version" and "Errors that the service counted, by version" search by the service name.
They show the versions of all copies of the service in the account. Look for the line of your own version.

**What the pipeline runs.** The synth and the deployment use the same commands as for a release. The assembly holds only the stage `Dev`.

```
npx cdk synth -c dev=true -c namespace=pr-12 -c version=0.0.0-pr12.abc1234
npx cdk deploy --app cdk.out "Dev/*" --require-approval never
npx cdk destroy --app cdk.out "Dev/*" --force
```

### The preview of a pull request

A pull request with the label `preview` gets its own copy of this service in the developer account.
The workflow `.github/workflows/preview.yml` calls the shared workflow of lab-workflows. It deploys the `Dev` stage under the namespace `pr-<number>`, for example `pr-12`.

- A comment on the pull request shows the URL. Call `GET <URL>/products`. The answer has the version of the pull request, `0.0.0-pr12.<commit>`, and the data of core.
- A push to the pull request deploys the new commit to the same URL.
- The copy reads core from the baseline copy of the account, because core has no namespace yet.
- When the pull request closes, or when you remove the label, the workflow removes the stack. A scheduled workflow removes any copy that stays behind.

The names are in the table of "Namespaces". The README of [lab-workflows](https://github.com/jross24/lab-workflows#the-temporary-environment-of-a-pull-request) explains the jobs and the security note.
A person with write access can deploy anything to the developer account with this label. The account is the fence, see that README.

### How another service adopts the namespace

Use this list for core, account and web. [lab-platform#36](https://github.com/jross24/lab-platform/issues/36) tracks the work.
The files `lib/namespace.ts` and `test/namespace.test.ts` in this repository are the model.

1. Copy `lib/namespace.ts`. Change the four names in `namesFor` to the names of the service. Keep `parseNamespace` as it is, so all services accept the same values.
2. In `lib/app.ts`, read the context value `namespace`. Throw when `dev` is off. Call `parseNamespace`. Pass the value to the `Dev` stage and to the stack as an optional property.
3. In the stack, take the stack name from `namesFor`. With no namespace the name must not change.
4. Rename every SSM parameter that the stack writes to `/lab/ns/<ns>/<service>/<name>`. This service writes two, `url` and `version`. Core also writes `api-arn`.
5. Set the dashboard name. The shared dashboard code fixes it, so use `addPropertyOverride('DashboardName', ...)` on the `CfnDashboard`, and only when there is a namespace.
6. Add the tag with `Tags.of(stack).add('lab-namespace', namespace)`, only when there is a namespace.
7. Search the stack for any other fixed name: `functionName`, `logGroupName`, `roleName`, `alarmName`, `exportName`, and the names of buckets and tables. Remove it or add the namespace.
8. Core only: do not create CloudWatch Transaction Search in a copy with a namespace. It is a setting of the whole account.
9. Copy `test/namespace.test.ts` and change the names. Keep the test that proves that the stages and the `Dev` stage with no namespace do not change.
10. Update the README of the service in the same pull request.

**The consumer and provider rule.** A copy writes its parameters only under its own path `/lab/ns/<ns>/`.
A copy reads the baseline path of its provider by default, for example `/lab/core/url`.
A copy reads the path of a provider preview only when a context value names it, for example `coreNamespace`. The provider must adopt the namespace first.
A copy never writes a baseline parameter, and it never reads the parameter of another copy by chance.

## Layout

| Path | Content |
| --- | --- |
| `bin/app.ts` | The entry point that `cdk.json` names. |
| `lib/app.ts` | Reads the context values (`version`, `dev` and `namespace`) and makes the stages. |
| `lib/namespace.ts` | Checks the context value `namespace` and makes the names of a copy: stack, URL parameter, version parameter and dashboard. |
| `lib/stages.ts` | The typed settings of each stage: log retention, the release type, the fault switch and the flag override. |
| `lib/catalogue-stage.ts` | The CDK stage. |
| `lib/catalogue-stack.ts` | The stack: SSM lookups, function, alias and release, IAM policy, API, dashboard, SSM parameters, outputs. |
| `lib/gradual-release.ts` | The alias, the deployment group, the three alarms and the `Release` type. A shared file. |
| `lib/service-dashboard.ts` | The dashboard of a stage. A shared file. |
| `lib/instrument.ts`, `lib/logger.ts`, `lib/metrics.ts` | The wrapper of the handler (it makes the server span), the log line and the metric line. Shared files. They also write the optional fields `flags`, `flagsSource` and `flagsOverridden`, which the handler sets for the flag `show-discounts`. |
| `lib/tracing.ts` | The OpenTelemetry tracing: the server span, the client span and the header `traceparent`. A shared file. |
| `lib/xray-exporter.ts` | Sends the spans to the OTLP endpoint of X-Ray. A shared file. |
| `lib/sigv4.ts` | Signs the export of the spans with AWS Signature Version 4. A shared file. |
| `lib/function-defaults.ts` | The memory and the esbuild settings of the function. A shared file. |
| `lib/products-handler.ts` | The Lambda handler, the fault switch and the flag `show-discounts`. |
| `lib/flag-client.ts` | Reads the flags with the AppConfig data API, keeps the session token, caches for 30 seconds, and returns the default (off) on any failure. |
| `lib/appconfig-data.ts` | The two AppConfig data calls with the AWS SDK. The SDK comes from the Lambda runtime. |
| `lib/flag-override.ts` | Reads the header `x-lab-flags`. |
| `lib/core-client.ts` | Calls `GET /items` of core as a client span, and checks the answer. |
| `lib/sign.ts` | Signs the call to core with AWS Signature Version 4. |
| `contract.json` | What `GET /products` promises to the web application. `test/contract.test.ts` checks that the real handler answers as the file says. |
| `expectations.json` | The fields of core that this service reads. `test/expectations.test.ts` checks that the client of core needs exactly these fields. |
| `shared.lock.json` | The pin: the commit of lab-workflows that the shared files come from. |
| `test/` | The unit tests (vitest). `tracing.test.ts`, `xray-exporter.test.ts`, `sigv4.test.ts`, `function-defaults.test.ts`, `contract-schema.test.ts` and `support/contract-schema.ts` are shared files. |
| `.github/workflows/` | Four small files that call the workflows in lab-workflows: `pr.yml`, `preview.yml`, `redeploy.yml` and `release.yml`. |

## Release gate

Each release runs the end-to-end suite of [lab-e2e](https://github.com/jross24/lab-e2e) in Test before it goes to Staging.

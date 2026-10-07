# lab-svc-catalogue

This repository holds the mock "catalogue" service of the pipeline lab.
It is an AWS CDK app in TypeScript. The pipeline in [lab-workflows](https://github.com/jross24/lab-workflows) releases it.

The service has the same shape as [lab-svc-core](https://github.com/jross24/lab-svc-core), and it uses the same release and observability pattern.
This README explains what is different. The lab-svc-core README explains the shared mechanics in more detail:
[Gradual release](https://github.com/jross24/lab-svc-core#gradual-release), [Observability](https://github.com/jross24/lab-svc-core#observability)
and [The Production drill](https://github.com/jross24/lab-svc-core#the-production-drill).

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

The API of core uses IAM authorisation. So the function signs each request with AWS Signature Version 4.
It signs with the temporary credentials of its own role. The Lambda runtime puts them in environment variables.
The file `lib/sign.ts` does the signing with `@smithy/signature-v4` and `@aws-crypto/sha256-js`. esbuild bundles both into the function.

The stack also writes its own address for the web application of a later phase.

| Parameter | Value |
| --- | --- |
| `/lab/catalogue/url` | The base URL of this API. Add `/products` to call the route. |

## Deployment order: core first

Deploy core to an account before you deploy this service to that account.

CloudFormation reads `/lab/core/url` and `/lab/core/api-arn` when it deploys this stack.
If core is not in the account, the parameters do not exist, and the deployment fails before it creates a resource.
The pipeline deploys each service on its own, so it does not enforce this order. You must keep it.

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

Every stage has the same resources: the same alias, the same CodeDeploy deployment group, the same three alarms and the same dashboard.
Only the values in the table differ. A unit test compares the three templates to check this.
`injectFault` is a device for the release drill. See "The Production drill". No stage sets it in `main`.

The code names no AWS account and no region. A stack goes to the account of the credentials that deploy it.
All three stages use the same bundled Lambda code.

## Gradual release and observability

This service follows the pattern of lab-svc-core. The core README explains how each part works.
This section shows what is the same, what is different, and the numbers that belong to this service.

### What is the same as core

- The alias `live`. The API calls the alias, and not the function. The route, the API and the parameter `/lab/catalogue/url` do not change, so the web application needs no change.
- The CodeDeploy deployment group. Test and Staging release all at once. Production releases a canary: 10 percent of the traffic for 5 minutes, then all of it.
- The alarms `ErrorsAlarm` and `LatencyAlarm`. CodeDeploy reads them during a deployment and rolls the release back when one fires.
- One JSON log line and one metric line (embedded metric format) for each request, with the service name `catalogue`. Active tracing with X-Ray. One dashboard, `lab-svc-catalogue`.
- The fault switch `injectFault` and the drill. The log retention of each stage.
- Five shared files, copied from core with no change: `lib/gradual-release.ts`, `lib/service-dashboard.ts`, `lib/instrument.ts`, `lib/logger.ts` and `lib/metrics.ts`.

### What is different from core

- **A third alarm.** `ServiceErrorsAlarm` reads the metric `errors` of the version that the stack deploys. The next section explains why.
- **Other numbers.** The latency threshold is 3000 ms and the function timeout is 10 seconds. Core uses 500 ms and 3 seconds.
- **A public route.** The route has no authoriser. The route of core uses IAM authorisation.
- **The call to core.** The function signs a request to core. The SSM parameter `/lab/catalogue/url`, the variable `CORE_URL` and the `execute-api:Invoke` policy do not change.
  The alias runs with the same role as the function, so the policy needs no new statement.
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

The tests are in `test/products-handler.test.ts`. The lab has not yet run this case in AWS.

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
Change the value when the lab has more traffic. Look at the graph "Duration of the alias live" on the dashboard.

### The first release makes the alias

CodeDeploy needs an old version to move traffic from. When the alias does not exist, CloudFormation creates it and starts no deployment.
So **the first release with this change goes to each stage with no canary**.

The second release is the first gradual release. Do not redeploy `0.1.0` or `0.1.1` with the `redeploy` workflow.
Those releases have no alias, so a redeploy removes the alias, the deployment group, the alarms and the dashboard.

The first release also moves the API from the function to the alias. The invoke permission of the alias must exist before the integration calls the alias, so the API stays up.
The stack makes each integration depend on each invoke permission of the API. A unit test checks this.

## The Production drill

The method is in the core README, section [The Production drill](https://github.com/jross24/lab-svc-core#the-production-drill). For this service:

1. In `lib/stages.ts`, set `injectFault: true` in the `Production` block.
2. In `test/app.test.ts`, change `DRILL_STAGES` to `['Production']`. The guard test fails if you change only one of the two files.
3. Merge the pull request with the title `fix: drill, inject a fault in production`. The release passes Test and Staging. Approve it in Production.
4. Send traffic to `GET /products` with the loop from the core README. The faulty version gets 10 percent of it. The function throws, so `ErrorsAlarm` fires and CodeDeploy rolls the release back.
5. Clean up with a second pull request that sets both values back. Give it the title `fix: remove the drill fault`.

A dry run with exactly these two edits passed lint, typecheck, all the tests and `cdk synth`. `INJECT_FAULT` appeared only in the Production template.
The lab has not run the drill itself.

With only the edit in `lib/stages.ts`, the guard test fails, as it should. The switch makes the function throw, so the drill tests `ErrorsAlarm` and not `ServiceErrorsAlarm`.
The unit tests in "What an error means here" cover the metric part of the third alarm.

## How a change reaches Production

1. Open a pull request. The `pr` workflow runs lint, typecheck, the tests and `cdk synth`.
2. Merge the pull request with a squash. The `release` workflow starts.
3. The workflow works out the next version from the commit title and creates the tag, for example `v0.2.0`.
4. The workflow builds one time and stores the zipped `cdk.out` in a GitHub release.
5. The workflow deploys that same zip to Test, then to Staging. In both, CodeDeploy moves the traffic at once.
6. The workflow waits. A reviewer approves the `production` environment in GitHub. Then the workflow deploys the same zip to Production. CodeDeploy moves 10 percent of the traffic, waits 5 minutes, and moves the rest.

A title that starts with `feat:` gives a minor version. A title with `!` before the colon gives a major version. Any other title gives a patch version.

To go back to an old version, run the `redeploy` workflow. It deploys the stored zip of that release and does not build.

```
gh workflow run redeploy.yml -f version=0.1.0 -f environment=test
```

The three files in `.github/workflows/` are copies of the files in lab-svc-core. This repository has no other pipeline code.

## Run the checks locally

You need Node.js 22.18 or later. Node.js runs the TypeScript files directly, so there is no build step.
esbuild bundles the Lambda code during `cdk synth`. You do not need Docker.

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

## Layout

| Path | Content |
| --- | --- |
| `bin/app.ts` | The entry point that `cdk.json` names. |
| `lib/app.ts` | Reads the context values and makes the stages. |
| `lib/stages.ts` | The typed settings of each stage: log retention, the release type and the fault switch. |
| `lib/catalogue-stage.ts` | The CDK stage. |
| `lib/catalogue-stack.ts` | The stack: SSM lookups, function, alias and release, IAM policy, API, dashboard, SSM parameter, outputs. |
| `lib/gradual-release.ts` | The alias, the deployment group, the three alarms and the `Release` type. The same file as in lab-svc-core. |
| `lib/service-dashboard.ts` | The dashboard of a stage. The same file as in lab-svc-core. |
| `lib/instrument.ts`, `lib/logger.ts`, `lib/metrics.ts` | The wrapper of the handler, the log line and the metric line. The same files as in lab-svc-core. |
| `lib/products-handler.ts` | The Lambda handler and the fault switch. |
| `lib/core-client.ts` | Calls `GET /items` of core and checks the answer. |
| `lib/sign.ts` | Signs a request with AWS Signature Version 4. |
| `test/` | The unit tests (vitest). |
| `.github/workflows/` | Three small files that call the workflows in lab-workflows. |

## Release gate

Each release runs the end-to-end suite of [lab-e2e](https://github.com/jross24/lab-e2e) in Test before it goes to Staging.

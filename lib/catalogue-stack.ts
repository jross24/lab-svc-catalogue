import { fileURLToPath } from 'node:url';
import { ArnFormat, CfnOutput, Duration, RemovalPolicy, Stack, Tags } from 'aws-cdk-lib';
import { CfnIntegration, HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type { CfnDashboard } from 'aws-cdk-lib/aws-cloudwatch';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { CfnPermission, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { FUNCTION_BUNDLING, FUNCTION_MEMORY_MB } from './function-defaults.ts';
import { GradualRelease } from './gradual-release.ts';
import { NAMESPACE_TAG, namesFor } from './namespace.ts';
import { ServiceDashboard } from './service-dashboard.ts';
import type { StageConfig } from './stages.ts';

const PRODUCTS_PATH = '/products';

// The function waits for core, and core can have a cold start. The latency alarm uses a threshold far below this limit.
export const FUNCTION_TIMEOUT = Duration.seconds(10);

// The p99 duration of the function, in milliseconds. The duration includes the signed call to core.
// The lab measured it in Test and Production (see "Where the latency threshold comes from" in the README):
// a warm p99 of about 1 second, and a cold request of up to 2.1 seconds.
// This value is 3 times the warm p99, and it is below a third of the timeout (3.3 seconds).
export const LATENCY_P99_THRESHOLD_MS = 3000;

export interface CatalogueStackProps {
  readonly version: string;
  readonly config: StageConfig;
  // Only the Dev stage sets it (the context value `namespace`). It gives the stack, the URL parameter and the
  // dashboard names of their own, so that several copies of the service can live in one account.
  // With no namespace the stack has the names of the baseline copy. See "Namespaces" in the README.
  readonly namespace?: string;
}

export class CatalogueStack extends Stack {
  constructor(scope: Construct, id: string, props: CatalogueStackProps) {
    const names = namesFor(props.namespace);
    // No env here: the stack takes the account and the region of the credentials that deploy it.
    super(scope, id, { stackName: names.stackName });

    // The tag goes to the stack and to every resource that can have a tag. A copy with no namespace has no tag.
    if (props.namespace !== undefined) Tags.of(this).add(NAMESPACE_TAG, props.namespace);

    // The core service writes these two parameters in each account.
    // CloudFormation reads them at deployment, so one synth serves each account.
    // So core must be in an account before this stack can go there.
    // A copy with a namespace reads the same two parameters: it calls the baseline copy of core in the account.
    const coreUrl = StringParameter.valueForStringParameter(this, '/lab/core/url');
    const coreApiArn = StringParameter.valueForStringParameter(this, '/lab/core/api-arn');

    // The lab-flags stack writes these three parameters in each account. The function needs them to find its flags
    // with the AppConfig data API. CloudFormation reads them at deployment, as it reads the parameters of core.
    // So lab-flags must be in an account before this stack can go there.
    const flagsApplicationId = StringParameter.valueForStringParameter(this, '/lab/flags/application-id');
    const flagsEnvironmentId = StringParameter.valueForStringParameter(this, '/lab/flags/environment-id');
    const flagsProfileId = StringParameter.valueForStringParameter(this, '/lab/flags/profile-id');

    const productsFunction = new NodejsFunction(this, 'ProductsFunction', {
      entry: fileURLToPath(new URL('./products-handler.ts', import.meta.url)),
      runtime: Runtime.NODEJS_22_X,
      timeout: FUNCTION_TIMEOUT,
      memorySize: FUNCTION_MEMORY_MB,
      bundling: FUNCTION_BUNDLING,
      // No active tracing of Lambda: OpenTelemetry makes the traces (lib/tracing.ts). The README of lab-svc-core explains why.
      environment: {
        // The version of the release is a part of the function, so each release publishes a new Lambda version.
        VERSION: props.version,
        CORE_URL: coreUrl,
        FLAGS_APPLICATION_ID: flagsApplicationId,
        FLAGS_ENVIRONMENT_ID: flagsEnvironmentId,
        FLAGS_PROFILE_ID: flagsProfileId,
        ...(props.config.injectFault ? { INJECT_FAULT: 'true' } : {}),
        // Only a stage that allows the override header gets the variable. The handler ignores the header without it.
        ...(props.config.allowFlagOverride ? { ALLOW_FLAG_OVERRIDE: 'true' } : {}),
      },
      logGroup: new LogGroup(this, 'ProductsFunctionLogs', {
        retention: props.config.logRetentionDays,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });

    // The API of core uses IAM authorisation. This is the only permission that the function needs for it.
    // The alias `live` runs with the same role, so the policy needs no change for the alias.
    productsFunction.addToRolePolicy(
      new PolicyStatement({ actions: ['execute-api:Invoke'], resources: [coreApiArn] }),
    );
    // The function sends its spans to the OTLP endpoint of X-Ray. The endpoint checks this permission.
    // X-Ray actions do not support a resource, so the resource is *.
    // The endpoint works only with Transaction Search, which the core stack turns on for the account.
    productsFunction.addToRolePolicy(new PolicyStatement({ actions: ['xray:PutTraceSegments'], resources: ['*'] }));

    // The function reads its feature flags with the AppConfig data API. These are the only two actions that it needs.
    // The resource is the one configuration of the lab-flags stack (application, environment and profile).
    productsFunction.addToRolePolicy(
      new PolicyStatement({
        actions: ['appconfig:StartConfigurationSession', 'appconfig:GetLatestConfiguration'],
        resources: [
          this.formatArn({
            service: 'appconfig',
            resource: 'application',
            arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
            resourceName: `${flagsApplicationId}/environment/${flagsEnvironmentId}/configuration/${flagsProfileId}`,
          }),
        ],
      }),
    );

    // The alias `live` is what the API calls. CodeDeploy moves the traffic of the alias to each new version.
    // The service answers 502 when the call to core fails, and it does not throw. Lambda counts no error then,
    // so the option serviceErrors adds a third alarm on the errors that the service counts itself.
    const release = new GradualRelease(this, 'Release', {
      function: productsFunction,
      release: props.config.release,
      latencyP99ThresholdMs: LATENCY_P99_THRESHOLD_MS,
      serviceErrors: { service: 'catalogue', version: props.version },
    });
    // The lab has no notification target. To page an on-call, make an SNS topic here and add it to the three alarms:
    //   release.errorsAlarm.addAlarmAction(new SnsAction(topic));
    //   release.latencyAlarm.addAlarmAction(new SnsAction(topic));
    //   release.serviceErrorsAlarm?.addAlarmAction(new SnsAction(topic));
    // The same alarms then page the on-call and stop a bad deployment. No other code changes.

    const api = new HttpApi(this, 'Api', { description: 'lab-svc-catalogue: mock public API' });

    // No authoriser: the route is public.
    // The integration calls the alias, not the function. The route and the API stay the same, so the web
    // application needs no change.
    api.addRoutes({
      path: PRODUCTS_PATH,
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration('ProductsIntegration', release.alias),
    });

    // The first release with an alias updates a running API. The integration moves from the function to the alias,
    // and the invoke permission moves too. Each permission must exist before an integration calls the alias.
    // Without these dependencies, CloudFormation may update an integration first, and the API fails for a few seconds.
    // The code covers all permissions and all integrations, so a later route needs no change here.
    const permissions = api.node.findAll().filter((node): node is CfnPermission => node instanceof CfnPermission);
    const integrations = api.node.findAll().filter((node): node is CfnIntegration => node instanceof CfnIntegration);
    if (permissions.length === 0 || integrations.length === 0) {
      throw new Error('The API has no integration or no invoke permission.');
    }
    for (const integration of integrations) {
      for (const permission of permissions) {
        integration.addResourceDependency(permission, 'The alias needs the invoke permission before the API calls it.');
      }
    }

    const dashboard = new ServiceDashboard(this, 'Dashboard', { service: 'catalogue', release, api });
    if (props.namespace !== undefined) {
      // The shared dashboard code (lib/service-dashboard.ts) always names the dashboard lab-svc-catalogue.
      // That file is a copy of the file in core, and it stays unchanged. So a copy with a namespace sets the name
      // in the template. The property dashboardName of the construct keeps the old name, and nothing here reads it.
      (dashboard.dashboard.node.defaultChild as CfnDashboard).addPropertyOverride('DashboardName', names.dashboardName);
    }

    // The web application reads this parameter to find the API.
    new StringParameter(this, 'UrlParameter', {
      parameterName: names.urlParameterName,
      description: 'Base URL of the catalogue API',
      stringValue: api.apiEndpoint,
    });

    // The pipeline of the other services reads this parameter. It checks the deployment order and the set of tested versions.
    const versionParameter = new StringParameter(this, 'VersionParameter', {
      parameterName: names.versionParameterName,
      description: 'Version of catalogue that this stack runs',
      stringValue: props.version,
    });
    // CloudFormation updates the alias, then waits for the CodeDeploy deployment (canary in Production), and only then
    // updates this parameter. So the parameter shows the new version when the release is complete.
    // A rollback of the traffic leaves the old version in the parameter.
    versionParameter.node.addDependency(release.alias);

    // The pipeline reads Version after a deployment. Do not add an output that contains the account ID:
    // the deploy job prints the outputs to a public log. The core API ARN contains the account ID.
    new CfnOutput(this, 'Version', { value: props.version });
    new CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
  }
}

// The context value `namespace` lets several copies of this service live in one account.
// The Dev stage reads it. The pipeline stages never do. See "Namespaces" in the README.

// The tag that marks every resource of a namespaced copy. It helps to find the resources and the cost of a copy.
export const NAMESPACE_TAG = 'lab-namespace';

// A letter first, then letters a-z, digits and hyphens. At most 20 characters. The code also refuses a hyphen at the end.
// The limit keeps the longest stack name (lab-svc-catalogue-<namespace>) far below the limit of CloudFormation.
const NAMESPACE = /^[a-z][a-z0-9-]{0,19}$/;

export function parseNamespace(value: unknown): string {
  if (typeof value !== 'string' || !NAMESPACE.test(value) || value.endsWith('-')) {
    throw new Error(
      `Context value namespace must be 1 to 20 characters: a letter a-z first, then letters a-z, digits and -, and no - at the end. Got ${JSON.stringify(value)}. Example: -c namespace=my-test`,
    );
  }
  return value;
}

// The names that must be unique in an account. Everything else in the stack gets its name from CloudFormation,
// and that name holds the stack name, so it is unique too.
export interface ServiceNames {
  readonly stackName: string;
  // The SSM parameter that holds the base URL of the API. The web application reads it.
  readonly urlParameterName: string;
  // The SSM parameter that holds the version that the stack runs. The release workflow reads the one of the baseline copy.
  readonly versionParameterName: string;
  readonly dashboardName: string;
}

// With no namespace the names are the names of the baseline copy of the account. They never change.
export function namesFor(namespace?: string): ServiceNames {
  if (namespace === undefined) {
    return {
      stackName: 'lab-svc-catalogue',
      urlParameterName: '/lab/catalogue/url',
      versionParameterName: '/lab/catalogue/version',
      dashboardName: 'lab-svc-catalogue',
    };
  }
  const valid = parseNamespace(namespace);
  return {
    stackName: `lab-svc-catalogue-${valid}`,
    urlParameterName: `/lab/ns/${valid}/catalogue/url`,
    versionParameterName: `/lab/ns/${valid}/catalogue/version`,
    dashboardName: `lab-svc-catalogue-${valid}`,
  };
}

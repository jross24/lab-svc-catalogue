import { describe, expect, it } from 'vitest';
import { CoreError, fetchCoreSummary } from '../lib/core-client.ts';
import { readJsonFile, requiredPaths, sample, validate, withoutPath } from './support/contract-schema.ts';
import type { Expectations, Schema } from './support/contract-schema.ts';

// What this service reads from core is the file expectations.json. The pull request check of the pipeline compares it
// with the contract of core that runs in Production. These tests keep the file true: the client of core needs exactly
// the fields that the file lists as required, and it does not read the old field name of core.

const expectations = readJsonFile<Expectations>(new URL('../expectations.json', import.meta.url));
const pipeline = readJsonFile<{ service: string; requires: Record<string, string> }>(new URL('../pipeline.json', import.meta.url));

// Fake values. The credentials are the example values from the AWS documentation and open nothing.
const ENV = {
  CORE_URL: 'https://abc123.execute-api.eu-west-2.amazonaws.com',
  AWS_REGION: 'eu-west-2',
  AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
  AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  AWS_SESSION_TOKEN: 'fake-session-token',
};

const ALLOWED_KEYS = ['type', 'properties', 'required', 'items', 'description'];

const schema = expectations.expects.core?.['GET /items']?.responses['200'] as Schema;

function call(body: unknown) {
  return fetchCoreSummary({ env: ENV, fetch: async () => Response.json(body) });
}

function fieldNames(node: Schema): string[] {
  return [
    ...Object.keys(node.properties ?? {}),
    ...Object.values(node.properties ?? {}).flatMap(fieldNames),
    ...(node.items ? fieldNames(node.items) : []),
  ];
}

// The pipeline refuses any other keyword, so nobody thinks that it is checked.
function keywordProblems(node: Schema, path: string): string[] {
  const problems = Object.keys(node)
    .filter((key) => !ALLOWED_KEYS.includes(key))
    .map((key) => `${path}: unsupported keyword ${key}`);
  for (const [name, child] of Object.entries(node.properties ?? {})) problems.push(...keywordProblems(child, `${path}.${name}`));
  if (node.items) problems.push(...keywordProblems(node.items, `${path}[]`));
  for (const name of node.required ?? []) {
    if (!(name in (node.properties ?? {}))) problems.push(`${path}: required name ${name} is not in properties`);
  }
  return problems;
}

describe('expectations.json', () => {
  it('names this service, the same name as pipeline.json', () => {
    expect(expectations.service).toBe(pipeline.service);
  });

  it('expects only the providers that pipeline.json requires', () => {
    expect(Object.keys(expectations.expects).sort()).toEqual(Object.keys(pipeline.requires).sort());
  });

  it('lists the call to GET /items of core and sends no request input', () => {
    expect(Object.keys(expectations.expects.core ?? {})).toEqual(['GET /items']);
    expect(expectations.expects.core?.['GET /items']?.sends).toEqual([]);
  });

  it('uses only the keywords that the pipeline understands', () => {
    expect(keywordProblems(schema, 'GET /items 200')).toEqual([]);
  });

  it('lists the fields that the client reads, and not the old field name of core', () => {
    expect(requiredPaths(schema)).toEqual([['version'], ['items']]);
    expect(fieldNames(schema)).not.toContain('name');
  });
});

describe('the client of core against the expectations', () => {
  it('copes with an answer that has exactly the listed fields', async () => {
    expect(validate(schema, sample(schema))).toEqual([]);
    await expect(call(sample(schema))).resolves.toEqual({ version: 'text', itemCount: 0 });
  });

  it('counts items that have a title and no name (the shape after core removes name)', async () => {
    const answer = {
      service: 'core',
      version: '1.0.0',
      items: [
        { id: 'item-1', title: 'First item' },
        { id: 'item-2', title: 'Second item' },
      ],
    };
    await expect(call(answer)).resolves.toEqual({ version: '1.0.0', itemCount: 2 });
  });

  it('counts items that have a name and no title (the shape before core 0.9.1)', async () => {
    const answer = { service: 'core', version: '0.9.0', items: [{ id: 'item-1', name: 'First item' }] };
    await expect(call(answer)).resolves.toEqual({ version: '0.9.0', itemCount: 1 });
  });

  it.each(requiredPaths(schema).map((path) => [path.join('.'), path] as const))(
    'fails when the required field %s is missing (the field is really needed)',
    async (_name, path) => {
      await expect(call(withoutPath(sample(schema), path))).rejects.toBeInstanceOf(CoreError);
    },
  );
});

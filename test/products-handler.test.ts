import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreError } from '../lib/core-client.ts';
import { createHandler } from '../lib/products-handler.ts';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const coreAnswers = async () => ({ version: '0.3.0', itemCount: 3 });

describe('products handler when core answers', () => {
  it('returns JSON with status 200', async () => {
    const response = await createHandler(coreAnswers)();
    expect(response.statusCode).toBe(200);
    expect(response.headers).toEqual({ 'content-type': 'application/json' });
  });

  it('returns its own name and version, the version and item count of core, and the products', async () => {
    vi.stubEnv('VERSION', '1.2.3');
    const body: unknown = JSON.parse((await createHandler(coreAnswers)()).body);
    expect(body).toEqual({
      service: 'catalogue',
      version: '1.2.3',
      core: { version: '0.3.0', itemCount: 3 },
      products: [
        { id: 'product-1', name: 'First product', price: 10 },
        { id: 'product-2', name: 'Second product', price: 20 },
      ],
    });
  });

  it('returns the version "unknown" when the environment has no version', async () => {
    vi.stubEnv('VERSION', undefined);
    const body: unknown = JSON.parse((await createHandler(coreAnswers)()).body);
    expect(body).toMatchObject({ version: 'unknown' });
  });
});

describe('products handler when the core call fails', () => {
  it('returns status 502 with a JSON error that names the cause', async () => {
    vi.stubEnv('VERSION', '1.2.3');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await createHandler(async () => {
      throw new CoreError('core returned HTTP 403');
    })();
    expect(response.statusCode).toBe(502);
    expect(response.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(response.body)).toEqual({
      service: 'catalogue',
      version: '1.2.3',
      error: 'The call to the core service failed.',
      cause: 'core returned HTTP 403',
    });
  });

  it('does not show the message of an unexpected error to the caller, and logs it', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const unexpected = new Error('internal detail');
    const response = await createHandler(async () => {
      throw unexpected;
    })();
    expect(response.statusCode).toBe(502);
    expect(JSON.parse(response.body)).toMatchObject({ cause: 'unexpected error' });
    expect(response.body).not.toContain('internal detail');
    expect(log).toHaveBeenCalledWith('The call to the core service failed.', unexpected);
  });
});

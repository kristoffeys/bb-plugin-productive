import { describe, expect, test, vi } from 'vitest';
import {
  ProductiveApiError,
  isRateLimited,
  retryAfterMs
} from '../productive/client.js';
import { createProductiveApi } from '../productive/index.js';

const CREDENTIALS = { apiToken: 'secret-token', organizationId: '9093' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/vnd.api+json' }
  });
}

function rateLimited(retryAfter?: string): Response {
  return new Response(
    JSON.stringify({
      errors: [{ status: '429', detail: 'Rate limit reached. Try again later' }]
    }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/vnd.api+json',
        ...(retryAfter === undefined ? {} : { 'Retry-After': retryAfter })
      }
    }
  );
}

describe('isRateLimited', () => {
  test('matches a 429 and a rate-limit body on any status', () => {
    expect(isRateLimited(new ProductiveApiError('nope', 429))).toBe(true);
    expect(
      isRateLimited(new ProductiveApiError('Rate limit reached. Try again later', 400))
    ).toBe(true);
    expect(isRateLimited(new ProductiveApiError('Not found', 404))).toBe(false);
    expect(isRateLimited(new Error('Rate limit reached'))).toBe(false);
  });
});

describe('retryAfterMs', () => {
  const headers = (value: string | null) => ({
    headers: { get: () => value }
  });

  test('reads a seconds value', () => {
    expect(retryAfterMs(headers('2'))).toBe(2000);
    expect(retryAfterMs(headers('0'))).toBe(0);
  });

  test('reads an HTTP date', () => {
    const future = new Date(Date.now() + 5000).toUTCString();
    const parsed = retryAfterMs(headers(future));
    expect(parsed).not.toBeNull();
    expect(parsed!).toBeGreaterThan(1000);
    expect(parsed!).toBeLessThanOrEqual(6000);
  });

  test('returns null when absent or unparsable', () => {
    expect(retryAfterMs(headers(null))).toBeNull();
    expect(retryAfterMs(headers('soon'))).toBeNull();
  });
});

describe('transport retry', () => {
  test('retries a rate-limited request and returns the eventual success', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(rateLimited('0'))
        .mockResolvedValueOnce(rateLimited('0'))
        .mockResolvedValueOnce(
          jsonResponse({
            data: [],
            meta: { current_page: 1, total_pages: 1, total_count: 0 }
          })
        );
      const api = createProductiveApi(CREDENTIALS, { fetchImpl });

      const pending = api.listTaskAttachments('892133');
      await vi.runAllTimersAsync();
      await expect(pending).resolves.toEqual([]);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test('gives up after the retry budget and reports the rate limit', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => rateLimited('0'));
      const api = createProductiveApi(CREDENTIALS, { fetchImpl });

      const pending = api.listTaskAttachments('892133').catch(error => error);
      await vi.runAllTimersAsync();
      const error = await pending;
      expect(error).toBeInstanceOf(ProductiveApiError);
      expect(isRateLimited(error)).toBe(true);
      // One initial attempt plus the retry budget.
      expect(fetchImpl).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });

  test('does not retry a non-rate-limit failure', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        jsonResponse({ errors: [{ detail: 'Not found' }] }, 404)
      );
    const api = createProductiveApi(CREDENTIALS, { fetchImpl });

    await expect(api.listTaskAttachments('nope')).rejects.toThrow(/not found/iu);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('never puts the token in a rate-limit error', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockImplementation(
          async () =>
            new Response(
              JSON.stringify({
                errors: [{ detail: 'Rate limit reached for token secret-token' }]
              }),
              {
                status: 429,
                headers: { 'Content-Type': 'application/vnd.api+json' }
              }
            )
        );
      const api = createProductiveApi(CREDENTIALS, { fetchImpl });
      const pending = api.listTaskAttachments('1').catch(error => error);
      await vi.runAllTimersAsync();
      const error = await pending;
      expect(String((error as Error).message)).not.toContain('secret-token');
      expect(String((error as Error).message)).toContain('[redacted]');
    } finally {
      vi.useRealTimers();
    }
  });
});

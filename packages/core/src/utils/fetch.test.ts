/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { lookup } from 'node:dns/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchPublicUrl,
  isPrivateIp,
  resolvesToBlockedAddress,
} from './fetch.js';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));

function mockLookup(address: string): void {
  vi.mocked(lookup).mockImplementation(() =>
    Promise.resolve([{ address, family: 4 }]),
  );
}

describe('isPrivateIp', () => {
  it.each([
    'http://localhost/admin',
    'http://localhost.localdomain/',
    'http://foo.localhost/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://127.0.0.1/',
    'http://0.0.0.0/',
    'http://10.1.2.3/',
    'http://172.16.0.1/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://[::]/',
    'http://[fe80::1]/',
    'http://[fd00::1]/',
    'http://[fc00::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://2130706433/',
  ])('blocks %s', (url) => {
    expect(isPrivateIp(url)).toBe(true);
  });

  it.each([
    'https://example.com/',
    'https://8.8.8.8/',
    'http://[::ffff:8.8.8.8]/',
    'http://172.15.0.1/',
    'http://172.32.0.1/',
    'http://134744072/',
  ])('allows %s', (url) => {
    expect(isPrivateIp(url)).toBe(false);
  });
});

describe('resolvesToBlockedAddress', () => {
  beforeEach(() => {
    vi.mocked(lookup).mockReset();
  });

  it('blocks a hostname that resolves to a link-local address', async () => {
    mockLookup('169.254.169.254');
    await expect(
      resolvesToBlockedAddress('https://metadata.example/'),
    ).resolves.toBe(true);
  });

  it('allows a hostname that resolves to a public address', async () => {
    mockLookup('93.184.216.34');
    await expect(
      resolvesToBlockedAddress('https://example.com/'),
    ).resolves.toBe(false);
  });

  it('does not treat DNS failure as a blocked address', async () => {
    vi.mocked(lookup).mockRejectedValue(new Error('ENOTFOUND'));
    await expect(
      resolvesToBlockedAddress('https://missing.example/'),
    ).resolves.toBe(false);
  });

  it('blocks a literal private address without a DNS lookup', async () => {
    await expect(
      resolvesToBlockedAddress('http://169.254.169.254/latest/meta-data/'),
    ).resolves.toBe(true);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('fetchPublicUrl', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    mockLookup('93.184.216.34');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not fetch a literal private address', async () => {
    await expect(
      fetchPublicUrl('http://127.0.0.1/secret', 1000),
    ).rejects.toMatchObject({ code: 'EBLOCKED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not follow a redirect to a metadata address', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('secret-body', {
        status: 302,
        headers: {
          location: 'http://169.254.169.254/latest/meta-data/',
        },
      }),
    );

    await expect(
      fetchPublicUrl('https://attacker.example/docs', 1000),
    ).rejects.toMatchObject({ code: 'EBLOCKED' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://attacker.example/docs',
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
  });

  it('follows a redirect only after the next hop is public', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response('', {
          status: 302,
          headers: { location: 'https://cdn.example/file' },
        }),
      )
      .mockResolvedValueOnce(new Response('public body', { status: 200 }));

    const response = await fetchPublicUrl(
      'https://attacker.example/docs',
      1000,
    );
    expect(await response.text()).toBe('public body');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      'https://cdn.example/file',
    );
  });

  it('stops after too many redirects', async () => {
    fetchMock.mockImplementation(
      () =>
        new Response('', {
          status: 302,
          headers: { location: 'https://attacker.example/again' },
        }),
    );

    await expect(
      fetchPublicUrl('https://attacker.example/docs', 1000),
    ).rejects.toMatchObject({ code: 'EREDIRECT' });
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(6);
  });
});

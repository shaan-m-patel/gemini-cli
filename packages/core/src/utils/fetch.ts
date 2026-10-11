/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { getErrorMessage, isNodeError } from './errors.js';
import { URL } from 'node:url';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { ProxyAgent, setGlobalDispatcher } from 'undici';

const BLOCKED_HOST_NAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
]);

const MAX_PUBLIC_REDIRECTS = 5;

export class FetchError extends Error {
  constructor(
    message: string,
    public code?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'FetchError';
  }
}

function stripHost(hostname: string): string {
  return hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
}

function ipv4FromMapped(host: string): string | null {
  if (!host.startsWith('::ffff:')) {
    return null;
  }
  const rest = host.slice('::ffff:'.length);
  if (ipv4ToInt(rest) !== null) {
    return rest;
  }
  const parts = rest.split(':');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    return null;
  }
  const hi = Number.parseInt(parts[0], 16);
  const lo = Number.parseInt(parts[1], 16);
  if (
    !Number.isInteger(hi) ||
    !Number.isInteger(lo) ||
    hi < 0 ||
    hi > 0xffff ||
    lo < 0 ||
    lo > 0xffff
  ) {
    return null;
  }
  return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join('.');
}

function ipv4ToInt(host: string): number | null {
  const parts = host.split('.');
  if (parts.length !== 4) {
    return null;
  }
  const nums = parts.map((part) => Number(part));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return ((nums[0] << 24) | (nums[1] << 16) | (nums[2] << 8) | nums[3]) >>> 0;
}

/**
 * True for loopback, link-local, private, unique-local, and localhost names.
 * The check is on the hostname string only; DNS answers are handled separately.
 */
export function isBlockedHostname(hostname: string): boolean {
  const host = stripHost(hostname);
  if (
    host.length === 0 ||
    BLOCKED_HOST_NAMES.has(host) ||
    host.endsWith('.localhost')
  ) {
    return true;
  }

  const mapped = ipv4FromMapped(host);
  if (mapped) {
    return isBlockedHostname(mapped);
  }

  if (host.includes(':')) {
    if (host === '::1' || host === '::') {
      return true;
    }
    if (host.startsWith('fe80:')) {
      return true;
    }
    return /^f[cd][0-9a-f]{0,2}:/.test(host);
  }

  // Decimal IPv4, such as 2130706433 for 127.0.0.1.
  if (/^\d+$/.test(host)) {
    const value = Number(host);
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
      return false;
    }
    const dotted = [
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff,
    ].join('.');
    return isBlockedHostname(dotted);
  }

  const ip = ipv4ToInt(host);
  if (ip === null) {
    return false;
  }
  const first = (ip >>> 24) & 0xff;
  const second = (ip >>> 16) & 0xff;
  if (first === 0 || first === 10 || first === 127) {
    return true;
  }
  if (first === 169 && second === 254) {
    return true;
  }
  if (first === 172 && second >= 16 && second <= 31) {
    return true;
  }
  return first === 192 && second === 168;
}

export function isPrivateIp(url: string): boolean {
  try {
    return isBlockedHostname(new URL(url).hostname);
  } catch (_e) {
    return false;
  }
}

/**
 * Resolves a hostname and reports whether any answer is a blocked address.
 * DNS failure is not treated as blocked; the fetch itself will fail later.
 */
export async function resolvesToBlockedAddress(url: string): Promise<boolean> {
  let hostname: string;
  try {
    hostname = stripHost(new URL(url).hostname);
  } catch {
    return true;
  }
  if (isBlockedHostname(hostname) || isIP(hostname)) {
    return isBlockedHostname(hostname);
  }
  try {
    const records = await lookup(hostname, { all: true, verbatim: true });
    return records.some((record) => isBlockedHostname(record.address));
  } catch {
    return false;
  }
}

function isRedirectStatus(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

/**
 * Fetches a public URL. Redirects are followed only after each hop is checked
 * again, so a public page cannot redirect the machine at a metadata address.
 */
export async function fetchPublicUrl(
  url: string,
  timeout: number,
  redirectsLeft = MAX_PUBLIC_REDIRECTS,
): Promise<Response> {
  if (isPrivateIp(url) || (await resolvesToBlockedAddress(url))) {
    throw new FetchError(
      `Refusing to fetch blocked address ${url}`,
      'EBLOCKED',
    );
  }

  const response = await fetchWithTimeout(url, timeout, {
    redirect: 'manual',
  });
  if (!isRedirectStatus(response.status)) {
    return response;
  }
  if (redirectsLeft <= 0) {
    throw new FetchError('Too many redirects', 'EREDIRECT');
  }
  const location = response.headers.get('location');
  if (!location) {
    throw new FetchError('Redirect missing location', 'EREDIRECT');
  }
  return fetchPublicUrl(
    new URL(location, url).toString(),
    timeout,
    redirectsLeft - 1,
  );
}

export async function fetchWithTimeout(
  url: string,
  timeout: number,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return response;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ABORT_ERR') {
      throw new FetchError(`Request timed out after ${timeout}ms`, 'ETIMEDOUT');
    }
    throw new FetchError(getErrorMessage(error), undefined, { cause: error });
  } finally {
    clearTimeout(timeoutId);
  }
}

export function setGlobalProxy(proxy: string) {
  setGlobalDispatcher(new ProxyAgent(proxy));
}

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const CODER_AGENT_AUTH_TOKEN_ENV = 'CODER_AGENT_AUTH_TOKEN';

/**
 * Requires `Authorization: Bearer <CODER_AGENT_AUTH_TOKEN>` on every route.
 * The server is bound to localhost, but other local users can still reach it.
 */
export function requireCoderAgentAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const expected = process.env[CODER_AGENT_AUTH_TOKEN_ENV];
  if (!expected) {
    res.status(503).json({
      error:
        'CODER_AGENT_AUTH_TOKEN is not set. Refusing unauthenticated requests.',
    });
    return;
  }

  const header = req.header('authorization');
  const provided =
    header && header.toLowerCase().startsWith('bearer ')
      ? header.slice('bearer '.length)
      : '';
  if (!tokensMatch(provided, expected)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

function tokensMatch(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) {
    timingSafeEqual(expectedBuf, expectedBuf);
    return false;
  }
  return timingSafeEqual(providedBuf, expectedBuf);
}

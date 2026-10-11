/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { copyExtension } from './extension-manager.js';

describe('copyExtension', () => {
  it('does not copy the clone git directory', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-ext-copy-'));
    const source = path.join(root, 'source');
    const destination = path.join(root, 'dest');
    fs.mkdirSync(path.join(source, '.git'), { recursive: true });
    fs.writeFileSync(
      path.join(source, '.git', 'config'),
      '[remote "origin"]\n\turl = https://token@github.com/owner/repo.git\n',
    );
    fs.writeFileSync(path.join(source, 'gemini-extension.json'), '{}\n');

    try {
      await copyExtension(source, destination);
      expect(
        fs.existsSync(path.join(destination, 'gemini-extension.json')),
      ).toBe(true);
      expect(fs.existsSync(path.join(destination, '.git'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

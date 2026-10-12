/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CoderAgentEvent } from '../types.js';
import {
  loadEnvironment,
  setTargetDir,
  UntrustedWorkspaceError,
} from './config.js';

const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
  delete process.env['CODER_AGENT_WORKSPACE_PATH'];
  delete process.env['CODER_AGENT_WORKSPACE_ALLOWLIST'];
  delete process.env['GEMINI_TEST_EXISTING'];
  delete process.env['GEMINI_TEST_FROM_DOTENV'];
});

describe('setTargetDir', () => {
  it('refuses a client workspace that is not on the operator allowlist', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-outside-'));
    expect(() =>
      setTargetDir({
        kind: CoderAgentEvent.StateAgentSettingsEvent,
        workspacePath: outside,
      }),
    ).toThrow(UntrustedWorkspaceError);
    expect(process.cwd()).toBe(originalCwd);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('enters a client workspace that the operator allowlisted', () => {
    const allowed = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-allowed-'));
    process.env['CODER_AGENT_WORKSPACE_ALLOWLIST'] = allowed;
    const result = setTargetDir({
      kind: CoderAgentEvent.StateAgentSettingsEvent,
      workspacePath: allowed,
    });
    expect(result).toBe(fs.realpathSync(allowed));
    expect(process.cwd()).toBe(fs.realpathSync(allowed));
    fs.rmSync(allowed, { recursive: true, force: true });
  });

  it('does not treat the filesystem root as an allowlist entry', () => {
    process.env['CODER_AGENT_WORKSPACE_ALLOWLIST'] =
      path.parse(originalCwd).root;
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-root-'));
    expect(() =>
      setTargetDir({
        kind: CoderAgentEvent.StateAgentSettingsEvent,
        workspacePath: outside,
      }),
    ).toThrow(UntrustedWorkspaceError);
    fs.rmSync(outside, { recursive: true, force: true });
  });
});

describe('loadEnvironment', () => {
  it('does not let a workspace .env override existing variables', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-env-'));
    fs.writeFileSync(
      path.join(dir, '.env'),
      'GEMINI_TEST_EXISTING=from-file\nGEMINI_TEST_FROM_DOTENV=from-file\n',
    );
    process.env['GEMINI_TEST_EXISTING'] = 'from-operator';
    process.chdir(dir);
    loadEnvironment();
    expect(process.env['GEMINI_TEST_EXISTING']).toBe('from-operator');
    expect(process.env['GEMINI_TEST_FROM_DOTENV']).toBe('from-file');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

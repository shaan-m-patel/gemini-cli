/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  getConnectionConfigFromFile,
  validateWorkspacePath,
  getIdeServerHost,
} from './ide-connection-utils.js';
import { pathToFileURL } from 'node:url';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...(actual as object),
    promises: {
      ...actual.promises,
      readFile: vi.fn(),
      readdir: vi.fn(),
    },
    realpathSync: (p: string) => p,
    existsSync: vi.fn(() => false),
  };
});
vi.mock('node:os');

describe('ide-connection-utils', () => {
  beforeEach(() => {
    // Mock environment variables
    vi.stubEnv('GEMINI_CLI_IDE_WORKSPACE_PATH', '/test/workspace');
    vi.stubEnv('GEMINI_CLI_IDE_SERVER_PORT', '');
    vi.stubEnv('GEMINI_CLI_IDE_SERVER_STDIO_COMMAND', '');
    vi.stubEnv('GEMINI_CLI_IDE_SERVER_STDIO_ARGS', '');
    vi.stubEnv('GEMINI_CLI_IDE_AUTH_TOKEN', '');

    vi.spyOn(process, 'cwd').mockReturnValue('/test/workspace/sub-dir');
    vi.mocked(os.tmpdir).mockReturnValue('/tmp');
    vi.mocked(os.platform).mockReturnValue('linux');
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    vi.spyOn(fs.promises, 'lstat').mockImplementation(async (candidate) => {
      const value = String(candidate);
      const isDir = value.endsWith(`${path.sep}ide`) || value.endsWith('/ide');
      return {
        isSymbolicLink: () => false,
        isDirectory: () => isDir,
        isFile: () => !isDir,
        mode: isDir ? 0o700 : 0o600,
        uid: process.getuid?.() ?? 0,
      } as fs.Stats;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe('getConnectionConfigFromFile', () => {
    it('should return config from the specific pid file if it exists', async () => {
      const config = { port: '1234', workspacePath: '/test/workspace' };
      vi.mocked(fs.promises.readFile).mockResolvedValue(JSON.stringify(config));

      const result = await getConnectionConfigFromFile(12345);

      expect(result).toEqual(config);
      expect(fs.promises.readFile).toHaveBeenCalledWith(
        path.join('/tmp', 'gemini', 'ide', 'gemini-ide-server-12345.json'),
        'utf8',
      );
    });

    it('should refuse a world-writable discovery directory', async () => {
      vi.mocked(fs.promises.lstat).mockResolvedValue({
        isSymbolicLink: () => false,
        isDirectory: () => true,
        isFile: () => false,
        mode: 0o777,
        uid: process.getuid?.() ?? 0,
      } as fs.Stats);

      const result = await getConnectionConfigFromFile(12345);

      expect(result).toBeUndefined();
      expect(fs.promises.readFile).not.toHaveBeenCalled();
    });

    it('should refuse a discovery file owned by another user', async () => {
      vi.mocked(fs.promises.lstat).mockImplementation(async (candidate) => {
        const value = String(candidate);
        const isDir = value.endsWith('/ide');
        return {
          isSymbolicLink: () => false,
          isDirectory: () => isDir,
          isFile: () => !isDir,
          mode: isDir ? 0o700 : 0o600,
          uid: isDir
            ? (process.getuid?.() ?? 0)
            : (process.getuid?.() ?? 0) + 1,
        } as fs.Stats;
      });

      const result = await getConnectionConfigFromFile(12345);

      expect(result).toBeUndefined();
    });

    it('should drop a stdio command from discovery JSON', async () => {
      const config = {
        port: '1234',
        workspacePath: '/test/workspace',
        stdio: { command: 'evil', args: ['--payload'] },
      };
      vi.mocked(fs.promises.readFile).mockResolvedValue(JSON.stringify(config));

      const result = await getConnectionConfigFromFile(12345);

      expect(result).toEqual({
        port: '1234',
        workspacePath: '/test/workspace',
      });
      expect(result).not.toHaveProperty('stdio');
    });

    it('should return undefined if no config files are found', async () => {
      vi.mocked(fs.promises.readFile).mockRejectedValue(new Error('not found'));
      (
        vi.mocked(fs.promises.readdir) as Mock<
          (path: fs.PathLike) => Promise<string[]>
        >
      ).mockResolvedValue([]);

      const result = await getConnectionConfigFromFile(12345);

      expect(result).toBeUndefined();
    });

    it('should find and parse a single config file with the new naming scheme', async () => {
      const config = { port: '5678', workspacePath: '/test/workspace' };
      vi.mocked(fs.promises.readFile).mockRejectedValueOnce(
        new Error('not found'),
      ); // For old path
      (
        vi.mocked(fs.promises.readdir) as Mock<
          (path: fs.PathLike) => Promise<string[]>
        >
      ).mockResolvedValue(['gemini-ide-server-12345-123.json']);
      vi.mocked(fs.promises.readFile).mockResolvedValue(JSON.stringify(config));

      const result = await getConnectionConfigFromFile(12345);

      expect(result).toEqual(config);
      expect(fs.promises.readFile).toHaveBeenCalledWith(
        path.join('/tmp', 'gemini', 'ide', 'gemini-ide-server-12345-123.json'),
        'utf8',
      );
    });

    it('should filter out configs with invalid workspace paths', async () => {
      const validConfig = {
        port: '5678',
        workspacePath: '/test/workspace',
      };
      const invalidConfig = {
        port: '1111',
        workspacePath: '/invalid/workspace',
      };
      vi.mocked(fs.promises.readFile).mockRejectedValueOnce(
        new Error('not found'),
      );
      (
        vi.mocked(fs.promises.readdir) as Mock<
          (path: fs.PathLike) => Promise<string[]>
        >
      ).mockResolvedValue([
        'gemini-ide-server-12345-111.json',
        'gemini-ide-server-12345-222.json',
      ]);
      vi.mocked(fs.promises.readFile)
        .mockResolvedValueOnce(JSON.stringify(invalidConfig))
        .mockResolvedValueOnce(JSON.stringify(validConfig));

      const result = await getConnectionConfigFromFile(12345);

      expect(result).toEqual(validConfig);
    });

    it('should ignore a discovery file for a different PID', async () => {
      const targetPid = 12345;
      const otherPid = 67890;
      const validConfig = {
        port: '5678',
        workspacePath: '/test/workspace',
      };
      vi.mocked(fs.promises.readFile).mockRejectedValueOnce(
        new Error('not found'),
      );
      (
        vi.mocked(fs.promises.readdir) as Mock<
          (path: fs.PathLike) => Promise<string[]>
        >
      ).mockResolvedValue([`gemini-ide-server-${otherPid}-111.json`]);
      vi.mocked(fs.promises.readFile).mockResolvedValueOnce(
        JSON.stringify(validConfig),
      );

      const result = await getConnectionConfigFromFile(targetPid);

      expect(result).toBeUndefined();
      expect(fs.promises.readFile).not.toHaveBeenCalledWith(
        path.join(
          '/tmp',
          'gemini',
          'ide',
          `gemini-ide-server-${otherPid}-111.json`,
        ),
        'utf8',
      );
    });

    it('should prioritize the target PID over other PIDs', async () => {
      const targetPid = 12345;
      const otherPid = 67890;
      const targetConfig = { port: '1111', workspacePath: '/test/workspace' };
      const otherConfig = { port: '2222', workspacePath: '/test/workspace' };

      vi.mocked(fs.promises.readFile).mockRejectedValueOnce(
        new Error('not found'),
      );
      (
        vi.mocked(fs.promises.readdir) as Mock<
          (path: fs.PathLike) => Promise<string[]>
        >
      ).mockResolvedValue([
        `gemini-ide-server-${otherPid}-1.json`,
        `gemini-ide-server-${targetPid}-1.json`,
      ]);

      // readFile will be called for both files in the sorted order.
      // We expect targetPid file to be first.
      vi.mocked(fs.promises.readFile)
        .mockResolvedValueOnce(JSON.stringify(targetConfig))
        .mockResolvedValueOnce(JSON.stringify(otherConfig));

      const result = await getConnectionConfigFromFile(targetPid);

      expect(result).toEqual(targetConfig);
      expect(fs.promises.readFile).toHaveBeenCalledWith(
        path.join(
          '/tmp',
          'gemini',
          'ide',
          `gemini-ide-server-${targetPid}-1.json`,
        ),
        'utf8',
      );
    });

    it('should not connect using another process pid when the IDE pid has no file', async () => {
      const targetPid = 12345;
      vi.mocked(fs.promises.readFile).mockRejectedValueOnce(
        new Error('not found'),
      );
      (
        vi.mocked(fs.promises.readdir) as Mock<
          (path: fs.PathLike) => Promise<string[]>
        >
      ).mockResolvedValue([
        'gemini-ide-server-11111-1.json',
        'gemini-ide-server-22222-1.json',
      ]);

      const result = await getConnectionConfigFromFile(targetPid);

      expect(result).toBeUndefined();
    });

    it('should return the first valid config when multiple workspaces are valid', async () => {
      const config1 = { port: '1111', workspacePath: '/test/workspace' };
      const config2 = { port: '2222', workspacePath: '/test/workspace2' };
      vi.mocked(fs.promises.readFile).mockRejectedValueOnce(
        new Error('not found'),
      );
      (
        vi.mocked(fs.promises.readdir) as Mock<
          (path: fs.PathLike) => Promise<string[]>
        >
      ).mockResolvedValue([
        'gemini-ide-server-12345-111.json',
        'gemini-ide-server-12345-222.json',
      ]);
      vi.mocked(fs.promises.readFile)
        .mockResolvedValueOnce(JSON.stringify(config1))
        .mockResolvedValueOnce(JSON.stringify(config2));

      const result = await getConnectionConfigFromFile(12345);

      expect(result).toEqual(config1);
    });

    it('should prioritize the config matching the port from the environment variable', async () => {
      vi.stubEnv('GEMINI_CLI_IDE_SERVER_PORT', '2222');
      const config1 = { port: '1111', workspacePath: '/test/workspace' };
      const config2 = { port: '2222', workspacePath: '/test/workspace' };
      vi.mocked(fs.promises.readFile).mockRejectedValueOnce(
        new Error('not found'),
      );
      (
        vi.mocked(fs.promises.readdir) as Mock<
          (path: fs.PathLike) => Promise<string[]>
        >
      ).mockResolvedValue([
        'gemini-ide-server-12345-111.json',
        'gemini-ide-server-12345-222.json',
      ]);
      vi.mocked(fs.promises.readFile)
        .mockResolvedValueOnce(JSON.stringify(config1))
        .mockResolvedValueOnce(JSON.stringify(config2));

      const result = await getConnectionConfigFromFile(12345);

      expect(result).toEqual(config2);
    });

    it('should handle invalid JSON in one of the config files', async () => {
      const validConfig = { port: '2222', workspacePath: '/test/workspace' };
      vi.mocked(fs.promises.readFile).mockRejectedValueOnce(
        new Error('not found'),
      );
      (
        vi.mocked(fs.promises.readdir) as Mock<
          (path: fs.PathLike) => Promise<string[]>
        >
      ).mockResolvedValue([
        'gemini-ide-server-12345-111.json',
        'gemini-ide-server-12345-222.json',
      ]);
      vi.mocked(fs.promises.readFile)
        .mockResolvedValueOnce('invalid json')
        .mockResolvedValueOnce(JSON.stringify(validConfig));

      const result = await getConnectionConfigFromFile(12345);

      expect(result).toEqual(validConfig);
    });

    it('should return undefined if readdir throws an error', async () => {
      vi.mocked(fs.promises.readFile).mockRejectedValueOnce(
        new Error('not found'),
      );
      vi.mocked(fs.promises.readdir).mockRejectedValue(
        new Error('readdir failed'),
      );

      const result = await getConnectionConfigFromFile(12345);

      expect(result).toBeUndefined();
    });

    it('should ignore files with invalid names', async () => {
      const validConfig = { port: '3333', workspacePath: '/test/workspace' };
      vi.mocked(fs.promises.readFile).mockRejectedValueOnce(
        new Error('not found'),
      );
      (
        vi.mocked(fs.promises.readdir) as Mock<
          (path: fs.PathLike) => Promise<string[]>
        >
      ).mockResolvedValue([
        'gemini-ide-server-12345-111.json', // valid
        'not-a-config-file.txt', // invalid
        'gemini-ide-server-asdf.json', // invalid
      ]);
      vi.mocked(fs.promises.readFile).mockResolvedValueOnce(
        JSON.stringify(validConfig),
      );

      const result = await getConnectionConfigFromFile(12345);

      expect(result).toEqual(validConfig);
      expect(fs.promises.readFile).toHaveBeenCalledWith(
        path.join('/tmp', 'gemini', 'ide', 'gemini-ide-server-12345-111.json'),
        'utf8',
      );
      expect(fs.promises.readFile).not.toHaveBeenCalledWith(
        path.join('/tmp', 'gemini', 'ide', 'not-a-config-file.txt'),
        'utf8',
      );
    });

    it('should match env port string to a number port in the config', async () => {
      vi.stubEnv('GEMINI_CLI_IDE_SERVER_PORT', '3333');
      const config1 = { port: 1111, workspacePath: '/test/workspace' };
      const config2 = { port: 3333, workspacePath: '/test/workspace' };
      vi.mocked(fs.promises.readFile).mockRejectedValueOnce(
        new Error('not found'),
      );
      (
        vi.mocked(fs.promises.readdir) as Mock<
          (path: fs.PathLike) => Promise<string[]>
        >
      ).mockResolvedValue([
        'gemini-ide-server-12345-111.json',
        'gemini-ide-server-12345-222.json',
      ]);
      vi.mocked(fs.promises.readFile)
        .mockResolvedValueOnce(JSON.stringify(config1))
        .mockResolvedValueOnce(JSON.stringify(config2));

      const result = await getConnectionConfigFromFile(12345);

      expect(result).toEqual(config2);
    });
  });

  describe('validateWorkspacePath', () => {
    it('should return valid if path is within cwd', () => {
      const result = validateWorkspacePath(
        '/test/workspace',
        '/test/workspace/sub-dir',
      );
      expect(result.isValid).toBe(true);
    });

    it('should return invalid if path is undefined', () => {
      const result = validateWorkspacePath(
        undefined,
        '/test/workspace/sub-dir',
      );
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Failed to connect');
    });

    it('should return invalid if path is empty', () => {
      const result = validateWorkspacePath('', '/test/workspace/sub-dir');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('please open a workspace folder');
    });

    it('should reject the filesystem root as a workspace path', () => {
      const result = validateWorkspacePath('/', '/test/workspace/sub-dir');
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('filesystem root');
    });

    it('should return invalid if cwd is not within workspace path', () => {
      const result = validateWorkspacePath(
        '/other/workspace',
        '/test/workspace/sub-dir',
      );
      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Directory mismatch');
    });
  });
  describe('with special characters and encoding', () => {
    it('should return true for a URI-encoded path with spaces', () => {
      const workspaceDir = path.resolve('/test/my workspace');
      const workspacePath = '/test/my%20workspace';
      const cwd = path.join(workspaceDir, 'sub-dir');
      const result = validateWorkspacePath(workspacePath, cwd);
      expect(result.isValid).toBe(true);
    });

    it('should return true for a URI-encoded path with Korean characters', () => {
      const workspaceDir = path.resolve('/test/테스트');
      const workspacePath = '/test/%ED%85%8C%EC%8A%A4%ED%8A%B8'; // "테스트"
      const cwd = path.join(workspaceDir, 'sub-dir');
      const result = validateWorkspacePath(workspacePath, cwd);
      expect(result.isValid).toBe(true);
    });

    it('should return true for a plain decoded path with Korean characters', () => {
      const workspacePath = path.resolve('/test/테스트');
      const cwd = path.join(workspacePath, 'sub-dir');
      const result = validateWorkspacePath(workspacePath, cwd);
      expect(result.isValid).toBe(true);
    });

    it('should return true when one of multi-root paths is a valid URI-encoded path', () => {
      const workspaceDir1 = path.resolve('/another/workspace');
      const workspaceDir2 = path.resolve('/test/테스트');
      const workspacePath = [
        workspaceDir1,
        '/test/%ED%85%8C%EC%8A%A4%ED%8A%B8', // "테스트"
      ].join(path.delimiter);
      const cwd = path.join(workspaceDir2, 'sub-dir');
      const result = validateWorkspacePath(workspacePath, cwd);
      expect(result.isValid).toBe(true);
    });

    it('should return true for paths containing a literal % sign', () => {
      const workspacePath = path.resolve('/test/a%path');
      const cwd = path.join(workspacePath, 'sub-dir');
      const result = validateWorkspacePath(workspacePath, cwd);
      expect(result.isValid).toBe(true);
    });

    it.skipIf(process.platform !== 'win32')(
      'should correctly convert a Windows file URI',
      () => {
        const workspacePath = 'file:///C:\\Users\\test';
        const cwd = 'C:\\Users\\test\\sub-dir';

        const result = validateWorkspacePath(workspacePath, cwd);

        expect(result.isValid).toBe(true);
      },
    );
  });

  describe('validateWorkspacePath (sanitization)', () => {
    it.each([
      {
        description: 'should return true for identical paths',
        workspacePath: path.resolve('test', 'ws'),
        cwd: path.resolve('test', 'ws'),
        expectedValid: true,
      },
      {
        description: 'should return true when workspace has file:// protocol',
        workspacePath: pathToFileURL(path.resolve('test', 'ws')).toString(),
        cwd: path.resolve('test', 'ws'),
        expectedValid: true,
      },
      {
        description: 'should return true when workspace has encoded spaces',
        workspacePath: path.resolve('test', 'my ws').replace(/ /g, '%20'),
        cwd: path.resolve('test', 'my ws'),
        expectedValid: true,
      },
      {
        description:
          'should return true when cwd needs normalization matching workspace',
        workspacePath: path.resolve('test', 'my ws'),
        cwd: path.resolve('test', 'my ws').replace(/ /g, '%20'),
        expectedValid: true,
      },
    ])('$description', ({ workspacePath, cwd, expectedValid }) => {
      expect(validateWorkspacePath(workspacePath, cwd)).toMatchObject({
        isValid: expectedValid,
      });
    });
  });

  describe('getIdeServerHost', () => {
    // Helper to set existsSync mock behavior
    const existsSyncMock = vi.mocked(fs.existsSync);
    const setupFsMocks = (
      dockerenvExists: boolean,
      containerenvExists: boolean,
    ) => {
      existsSyncMock.mockImplementation((path: fs.PathLike) => {
        if (path === '/.dockerenv') {
          return dockerenvExists;
        }
        if (path === '/run/.containerenv') {
          return containerenvExists;
        }
        return false;
      });
    };

    it('should return 127.0.0.1 when not in container and no SSH_CONNECTION or Dev Container env vars', () => {
      setupFsMocks(false, false);
      vi.stubEnv('SSH_CONNECTION', '');
      vi.stubEnv('VSCODE_REMOTE_CONTAINERS_SESSION', '');
      vi.stubEnv('REMOTE_CONTAINERS', '');
      expect(getIdeServerHost()).toBe('127.0.0.1');
      expect(vi.mocked(fs.existsSync)).toHaveBeenCalledWith('/.dockerenv');
      expect(vi.mocked(fs.existsSync)).toHaveBeenCalledWith(
        '/run/.containerenv',
      );
    });

    it('should return 127.0.0.1 when not in container but SSH_CONNECTION is set', () => {
      setupFsMocks(false, false);
      vi.stubEnv('SSH_CONNECTION', 'some_ssh_value');
      vi.stubEnv('VSCODE_REMOTE_CONTAINERS_SESSION', '');
      vi.stubEnv('REMOTE_CONTAINERS', '');
      expect(getIdeServerHost()).toBe('127.0.0.1');
      expect(vi.mocked(fs.existsSync)).toHaveBeenCalledWith('/.dockerenv');
      expect(vi.mocked(fs.existsSync)).toHaveBeenCalledWith(
        '/run/.containerenv',
      );
    });

    it('should return host.docker.internal when in .dockerenv container and no SSH_CONNECTION or Dev Container env vars', () => {
      setupFsMocks(true, false);
      vi.stubEnv('SSH_CONNECTION', '');
      vi.stubEnv('VSCODE_REMOTE_CONTAINERS_SESSION', '');
      vi.stubEnv('REMOTE_CONTAINERS', '');
      expect(getIdeServerHost()).toBe('host.docker.internal');
      expect(vi.mocked(fs.existsSync)).toHaveBeenCalledWith('/.dockerenv');
      expect(vi.mocked(fs.existsSync)).not.toHaveBeenCalledWith(
        '/run/.containerenv',
      ); // Short-circuiting
    });

    it('should return 127.0.0.1 when in .dockerenv container and SSH_CONNECTION is set', () => {
      setupFsMocks(true, false);
      vi.stubEnv('SSH_CONNECTION', 'some_ssh_value');
      vi.stubEnv('VSCODE_REMOTE_CONTAINERS_SESSION', '');
      vi.stubEnv('REMOTE_CONTAINERS', '');
      expect(getIdeServerHost()).toBe('127.0.0.1');
      expect(vi.mocked(fs.existsSync)).toHaveBeenCalledWith('/.dockerenv');
      expect(vi.mocked(fs.existsSync)).not.toHaveBeenCalledWith(
        '/run/.containerenv',
      ); // Short-circuiting
    });

    it('should return 127.0.0.1 when in .dockerenv container and VSCODE_REMOTE_CONTAINERS_SESSION is set', () => {
      setupFsMocks(true, false);
      vi.stubEnv('SSH_CONNECTION', '');
      vi.stubEnv('VSCODE_REMOTE_CONTAINERS_SESSION', 'some_session_id');
      expect(getIdeServerHost()).toBe('127.0.0.1');
      expect(vi.mocked(fs.existsSync)).toHaveBeenCalledWith('/.dockerenv');
      expect(vi.mocked(fs.existsSync)).not.toHaveBeenCalledWith(
        '/run/.containerenv',
      ); // Short-circuiting
    });

    it('should return host.docker.internal when in .containerenv container and no SSH_CONNECTION or Dev Container env vars', () => {
      setupFsMocks(false, true);
      vi.stubEnv('SSH_CONNECTION', '');
      vi.stubEnv('VSCODE_REMOTE_CONTAINERS_SESSION', '');
      vi.stubEnv('REMOTE_CONTAINERS', '');
      expect(getIdeServerHost()).toBe('host.docker.internal');
      expect(vi.mocked(fs.existsSync)).toHaveBeenCalledWith('/.dockerenv');
      expect(vi.mocked(fs.existsSync)).toHaveBeenCalledWith(
        '/run/.containerenv',
      );
    });

    it('should return 127.0.0.1 when in .containerenv container and SSH_CONNECTION is set', () => {
      setupFsMocks(false, true);
      vi.stubEnv('SSH_CONNECTION', 'some_ssh_value');
      vi.stubEnv('VSCODE_REMOTE_CONTAINERS_SESSION', '');
      vi.stubEnv('REMOTE_CONTAINERS', '');
      expect(getIdeServerHost()).toBe('127.0.0.1');
      expect(vi.mocked(fs.existsSync)).toHaveBeenCalledWith('/.dockerenv');
      expect(vi.mocked(fs.existsSync)).toHaveBeenCalledWith(
        '/run/.containerenv',
      );
    });

    it('should return 127.0.0.1 when in .containerenv container and REMOTE_CONTAINERS is set', () => {
      setupFsMocks(false, true);
      vi.stubEnv('SSH_CONNECTION', '');
      vi.stubEnv('REMOTE_CONTAINERS', 'true');
      expect(getIdeServerHost()).toBe('127.0.0.1');
      expect(vi.mocked(fs.existsSync)).toHaveBeenCalledWith('/.dockerenv');
      expect(vi.mocked(fs.existsSync)).toHaveBeenCalledWith(
        '/run/.containerenv',
      );
    });

    it('should return host.docker.internal when in both containers and no SSH_CONNECTION or Dev Container env vars', () => {
      setupFsMocks(true, true);
      vi.stubEnv('SSH_CONNECTION', '');
      vi.stubEnv('VSCODE_REMOTE_CONTAINERS_SESSION', '');
      vi.stubEnv('REMOTE_CONTAINERS', '');
      expect(getIdeServerHost()).toBe('host.docker.internal');
      expect(vi.mocked(fs.existsSync)).toHaveBeenCalledWith('/.dockerenv');
      expect(vi.mocked(fs.existsSync)).not.toHaveBeenCalledWith(
        '/run/.containerenv',
      ); // Short-circuiting
    });

    it('should return 127.0.0.1 when in both containers and SSH_CONNECTION is set', () => {
      setupFsMocks(true, true);
      vi.stubEnv('SSH_CONNECTION', 'some_ssh_value');
      vi.stubEnv('VSCODE_REMOTE_CONTAINERS_SESSION', '');
      vi.stubEnv('REMOTE_CONTAINERS', '');
      expect(getIdeServerHost()).toBe('127.0.0.1');
      expect(vi.mocked(fs.existsSync)).toHaveBeenCalledWith('/.dockerenv');
      expect(vi.mocked(fs.existsSync)).not.toHaveBeenCalledWith(
        '/run/.containerenv',
      ); // Short-circuiting
    });

    it('should return 127.0.0.1 when in both containers and VSCODE_REMOTE_CONTAINERS_SESSION is set', () => {
      setupFsMocks(true, true);
      vi.stubEnv('SSH_CONNECTION', '');
      vi.stubEnv('VSCODE_REMOTE_CONTAINERS_SESSION', 'some_session_id');
      expect(getIdeServerHost()).toBe('127.0.0.1');
      expect(vi.mocked(fs.existsSync)).toHaveBeenCalledWith('/.dockerenv');
      expect(vi.mocked(fs.existsSync)).not.toHaveBeenCalledWith(
        '/run/.containerenv',
      ); // Short-circuiting
    });
  });
});

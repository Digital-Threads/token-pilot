/**
 * Review 1.0.2 — on Windows the command has no process group: killing the
 * shell (cmd.exe) on timeout left the test runner running. `taskkill /T`
 * walks the tree there.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn }));

import { killTree } from '../../src/handlers/test-summary.js';

afterEach(() => {
  spawn.mockReset();
  vi.restoreAllMocks();
});

describe('killTree', () => {
  it('on Windows runs taskkill over the whole tree', () => {
    spawn.mockReturnValue({ on: vi.fn() });
    killTree(4242, 'SIGTERM', 'win32');
    expect(spawn).toHaveBeenCalledWith('taskkill', ['/pid', '4242', '/T', '/F'], expect.objectContaining({ stdio: 'ignore' }));
  });

  it('on Windows never throws when taskkill cannot start', () => {
    spawn.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(() => killTree(4242, 'SIGKILL', 'win32')).not.toThrow();
  });

  it('elsewhere signals the process group', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    killTree(4242, 'SIGTERM', 'linux');
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGTERM');
    expect(spawn).not.toHaveBeenCalled();
  });
});

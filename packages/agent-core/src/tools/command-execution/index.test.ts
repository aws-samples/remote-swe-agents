import { describe, expect, test, vi } from 'vitest';
import { executeCommand } from './index';

vi.mock('./github', () => ({
  authorizeGitHubCli: async () => undefined,
  isGitHubConfigured: () => false,
}));

describe('executeCommand with cancellationToken', () => {
  test('resolves immediately on cancellation without killing the process', async () => {
    const cancellationToken = { isCancelled: false };

    const startTime = Date.now();
    const resultPromise = executeCommand('sleep 300', undefined, 60000, false, undefined, cancellationToken);

    await new Promise((resolve) => setTimeout(resolve, 200));
    (cancellationToken as any).isCancelled = true;

    const result = await resultPromise;
    const elapsed = Date.now() - startTime;

    expect(result.error).toContain('still running in background');
    expect(result.error).toContain('PID:');
    // Should resolve quickly, not wait for the 300s sleep
    expect(elapsed).toBeLessThan(3000);
  }, 10000);

  test('includes partial stdout and PID in cancellation result', async () => {
    const cancellationToken = { isCancelled: false };

    const resultPromise = executeCommand(
      'echo hello && sleep 300',
      undefined,
      60000,
      false,
      undefined,
      cancellationToken
    );

    await new Promise((resolve) => setTimeout(resolve, 500));
    (cancellationToken as any).isCancelled = true;

    const result = await resultPromise;
    expect(result.stdout).toContain('hello');
    expect(result.error).toContain('PID:');
    expect(result.error).toContain('still running in background');
  }, 10000);

  test('process continues running after cancellation', async () => {
    const cancellationToken = { isCancelled: false };
    const marker = `rswealive${Date.now()}`;

    const resultPromise = executeCommand(
      `bash -c 'while true; do sleep 1; done' # ${marker}`,
      undefined,
      60000,
      false,
      undefined,
      cancellationToken
    );

    await new Promise((resolve) => setTimeout(resolve, 500));
    (cancellationToken as any).isCancelled = true;

    const result = await resultPromise;

    // Process should still be running
    const checkResult = await executeCommand(`ps aux | grep "${marker}" | grep -v grep | wc -l`, undefined, 5000);
    const count = parseInt(checkResult.stdout.trim(), 10);
    expect(count).toBeGreaterThan(0);

    // Cleanup: kill the background process using PID from result
    const pidMatch = result.error?.match(/PID: (\d+)/);
    if (pidMatch) {
      try {
        process.kill(parseInt(pidMatch[1]!, 10), 'SIGTERM');
      } catch {
        /* already exited */
      }
    }
    // Also kill by marker just in case
    await executeCommand(`pkill -f "${marker}" || true`, undefined, 5000);
  }, 15000);

  test('completes normally when not cancelled', async () => {
    const cancellationToken = { isCancelled: false };

    const result = await executeCommand('echo hello', undefined, 60000, false, undefined, cancellationToken);

    expect(result.stdout).toContain('hello');
    expect(result.error).toBeUndefined();
  }, 10000);

  test('works without cancellationToken (backward compatibility)', async () => {
    const result = await executeCommand('echo test');

    expect(result.stdout).toContain('test');
    expect(result.error).toBeUndefined();
  }, 10000);

  test('cancellation resolves rather than rejects', async () => {
    const cancellationToken = { isCancelled: false };

    const resultPromise = executeCommand('sleep 300', undefined, 60000, false, undefined, cancellationToken);

    await new Promise((resolve) => setTimeout(resolve, 200));
    (cancellationToken as any).isCancelled = true;

    await expect(resultPromise).resolves.toBeDefined();
  }, 10000);

  test('timeout after cancellation does not kill the process or remove PID file', async () => {
    const cancellationToken = { isCancelled: false };
    const marker = `rswetimeout${Date.now()}`;

    // Use a very short timeout so it fires quickly after cancellation
    const resultPromise = executeCommand(
      `bash -c 'while true; do sleep 1; done' # ${marker}`,
      undefined,
      1000, // 1 second timeout
      false,
      undefined,
      cancellationToken
    );

    // Wait for process to start, then cancel
    await new Promise((resolve) => setTimeout(resolve, 300));
    (cancellationToken as any).isCancelled = true;

    const result = await resultPromise;
    expect(result.error).toContain('still running in background');

    // Wait longer than the timeout (1s) to let it fire if it was going to
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Process should STILL be running — timeout must not have killed it
    const checkResult = await executeCommand(`ps aux | grep "${marker}" | grep -v grep | wc -l`, undefined, 5000);
    const count = parseInt(checkResult.stdout.trim(), 10);
    expect(count).toBeGreaterThan(0);

    // Cleanup
    await executeCommand(`pkill -f "${marker}" || true`, undefined, 5000);
  }, 15000);
});

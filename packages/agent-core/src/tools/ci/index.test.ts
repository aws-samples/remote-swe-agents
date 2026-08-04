import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { getPrCheckStatus } from './index';

vi.mock('../command-execution', () => ({
  executeCommand: vi.fn(),
}));

import { executeCommand } from '../command-execution';
const mockExecuteCommand = vi.mocked(executeCommand);

describe('getPrCheckStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('returns success when all checks pass', async () => {
    mockExecuteCommand.mockResolvedValue({
      stdout: JSON.stringify([
        {
          name: 'build',
          state: 'SUCCESS',
          workflow: 'CI',
          link: 'https://github.com/owner/repo/actions/runs/12345/jobs/67890',
          bucket: 'pass',
        },
        {
          name: 'lint',
          state: 'SUCCESS',
          workflow: 'CI',
          link: 'https://github.com/owner/repo/actions/runs/12345/jobs/67891',
          bucket: 'pass',
        },
      ]),
      stderr: '',
    });

    const result = await getPrCheckStatus('owner', 'repo', '1');
    expect(result).toEqual({ status: 'success' });
  });

  test('returns in_progress when checks are pending', async () => {
    mockExecuteCommand.mockResolvedValue({
      stdout: JSON.stringify([
        {
          name: 'build',
          state: 'PENDING',
          workflow: 'CI',
          link: 'https://github.com/owner/repo/actions/runs/12345/jobs/67890',
          bucket: 'pending',
        },
        {
          name: 'lint',
          state: 'SUCCESS',
          workflow: 'CI',
          link: 'https://github.com/owner/repo/actions/runs/12345/jobs/67891',
          bucket: 'pass',
        },
      ]),
      stderr: '',
    });

    const result = await getPrCheckStatus('owner', 'repo', '1');
    expect(result).toEqual({ status: 'in_progress' });
  });

  test('returns failure with Actions run IDs for failed GitHub Actions checks', async () => {
    mockExecuteCommand.mockResolvedValue({
      stdout: JSON.stringify([
        {
          name: 'build',
          state: 'FAILURE',
          workflow: 'CI',
          link: 'https://github.com/owner/repo/actions/runs/99999/jobs/12345',
          bucket: 'fail',
        },
        {
          name: 'lint',
          state: 'SUCCESS',
          workflow: 'CI',
          link: 'https://github.com/owner/repo/actions/runs/12345/jobs/67891',
          bucket: 'pass',
        },
      ]),
      stderr: '',
    });

    const result = await getPrCheckStatus('owner', 'repo', '1');
    expect(result).toEqual({
      status: 'failure',
      failedActionsRuns: [{ runId: '99999', name: 'build' }],
      failedExternalChecks: [],
    });
  });

  test('handles non-Actions checks (CodeBuild) without crashing', async () => {
    mockExecuteCommand.mockResolvedValue({
      stdout: JSON.stringify([
        {
          name: 'CodeBuild - my-project',
          state: 'FAILURE',
          workflow: '',
          link: 'https://ap-northeast-1.console.aws.amazon.com/codesuite/codebuild/projects/my-project/build/my-project:abc123',
          bucket: 'fail',
        },
      ]),
      stderr: '',
    });

    const result = await getPrCheckStatus('owner', 'repo', '148');
    expect(result).toEqual({
      status: 'failure',
      failedActionsRuns: [],
      failedExternalChecks: [
        {
          name: 'CodeBuild - my-project',
          link: 'https://ap-northeast-1.console.aws.amazon.com/codesuite/codebuild/projects/my-project/build/my-project:abc123',
          state: 'FAILURE',
        },
      ],
    });
  });

  test('handles mix of failed Actions and non-Actions checks', async () => {
    mockExecuteCommand.mockResolvedValue({
      stdout: JSON.stringify([
        {
          name: 'CI Build',
          state: 'FAILURE',
          workflow: 'CI',
          link: 'https://github.com/owner/repo/actions/runs/55555/jobs/11111',
          bucket: 'fail',
        },
        {
          name: 'CodeBuild - deploy',
          state: 'FAILURE',
          workflow: '',
          link: 'https://ap-northeast-1.console.aws.amazon.com/codesuite/codebuild/projects/deploy/build/deploy:xyz789',
          bucket: 'fail',
        },
        {
          name: 'External CI',
          state: 'FAILURE',
          workflow: '',
          link: 'https://ci.example.com/builds/42',
          bucket: 'fail',
        },
        {
          name: 'lint',
          state: 'SUCCESS',
          workflow: 'CI',
          link: 'https://github.com/owner/repo/actions/runs/55555/jobs/11112',
          bucket: 'pass',
        },
      ]),
      stderr: '',
    });

    const result = await getPrCheckStatus('owner', 'repo', '1');
    expect(result).toEqual({
      status: 'failure',
      failedActionsRuns: [{ runId: '55555', name: 'CI Build' }],
      failedExternalChecks: [
        {
          name: 'CodeBuild - deploy',
          link: 'https://ap-northeast-1.console.aws.amazon.com/codesuite/codebuild/projects/deploy/build/deploy:xyz789',
          state: 'FAILURE',
        },
        {
          name: 'External CI',
          link: 'https://ci.example.com/builds/42',
          state: 'FAILURE',
        },
      ],
    });
  });

  test('handles all failed checks being non-Actions (no Actions runs)', async () => {
    mockExecuteCommand.mockResolvedValue({
      stdout: JSON.stringify([
        {
          name: 'CodeBuild A',
          state: 'FAILURE',
          workflow: '',
          link: 'https://console.aws.amazon.com/codebuild/home',
          bucket: 'fail',
        },
        {
          name: 'Jenkins Build',
          state: 'FAILURE',
          workflow: '',
          link: 'https://jenkins.example.com/job/build/123',
          bucket: 'fail',
        },
      ]),
      stderr: '',
    });

    const result = await getPrCheckStatus('owner', 'repo', '5');
    expect(result).toEqual({
      status: 'failure',
      failedActionsRuns: [],
      failedExternalChecks: [
        {
          name: 'CodeBuild A',
          link: 'https://console.aws.amazon.com/codebuild/home',
          state: 'FAILURE',
        },
        {
          name: 'Jenkins Build',
          link: 'https://jenkins.example.com/job/build/123',
          state: 'FAILURE',
        },
      ],
    });
  });

  test('throws error when no checks are found', async () => {
    mockExecuteCommand.mockResolvedValue({
      stdout: JSON.stringify([]),
      stderr: '',
    });

    await expect(getPrCheckStatus('owner', 'repo', '1')).rejects.toThrow('No checks found for this PR');
  });

  test('handles checks with empty link gracefully', async () => {
    mockExecuteCommand.mockResolvedValue({
      stdout: JSON.stringify([
        {
          name: 'status-check',
          state: 'FAILURE',
          workflow: '',
          link: '',
          bucket: 'fail',
        },
      ]),
      stderr: '',
    });

    const result = await getPrCheckStatus('owner', 'repo', '1');
    expect(result).toEqual({
      status: 'failure',
      failedActionsRuns: [],
      failedExternalChecks: [
        {
          name: 'status-check',
          link: '',
          state: 'FAILURE',
        },
      ],
    });
  });
});

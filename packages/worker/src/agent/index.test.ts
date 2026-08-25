import { describe, expect, test, vi, afterEach } from 'vitest';
import {
  shouldResetReportTimer,
  toolNamesThatResetReportTimer,
  resolveInferenceMode,
  normalizeMcpImageFormat,
  emptyFinalMessageNotification,
} from './index';

describe('shouldResetReportTimer', () => {
  test('returns true for sendMessageToUser', () => {
    expect(shouldResetReportTimer('sendMessageToUser')).toBe(true);
  });

  test('returns true for sendMessageToAgent', () => {
    expect(shouldResetReportTimer('sendMessageToAgent')).toBe(true);
  });

  test('returns true for acknowledgeAgent', () => {
    expect(shouldResetReportTimer('acknowledgeAgent')).toBe(true);
  });

  test('returns false for unrelated tools', () => {
    expect(shouldResetReportTimer('executeCommand')).toBe(false);
    expect(shouldResetReportTimer('fileEditor')).toBe(false);
    expect(shouldResetReportTimer('cloneGitHubRepository')).toBe(false);
  });

  test('returns false for undefined', () => {
    expect(shouldResetReportTimer(undefined)).toBe(false);
  });

  test('returns false for empty string', () => {
    expect(shouldResetReportTimer('')).toBe(false);
  });
});

describe('toolNamesThatResetReportTimer', () => {
  test('contains exactly the three expected tool names', () => {
    expect(toolNamesThatResetReportTimer.size).toBe(3);
    expect(toolNamesThatResetReportTimer.has('sendMessageToUser')).toBe(true);
    expect(toolNamesThatResetReportTimer.has('sendMessageToAgent')).toBe(true);
    expect(toolNamesThatResetReportTimer.has('acknowledgeAgent')).toBe(true);
  });
});

describe('resolveInferenceMode', () => {
  test('returns custom agent setting when present', () => {
    expect(
      resolveInferenceMode({
        customAgentInferenceMode: 'kiro-cli',
        envInferenceMode: 'bedrock',
      })
    ).toBe('kiro-cli');
  });

  test('falls back to env var when no session or custom agent setting', () => {
    expect(
      resolveInferenceMode({
        customAgentInferenceMode: undefined,
        envInferenceMode: 'kiro-cli',
      })
    ).toBe('kiro-cli');
  });

  test('defaults to bedrock when nothing is set (legacy session)', () => {
    expect(resolveInferenceMode({})).toBe('bedrock');
  });

  test('custom agent overrides env', () => {
    expect(
      resolveInferenceMode({
        customAgentInferenceMode: 'bedrock',
        envInferenceMode: 'kiro-cli',
      })
    ).toBe('bedrock');
  });

  test('ignores non-kiro-cli env values', () => {
    expect(
      resolveInferenceMode({
        envInferenceMode: 'something-else',
      })
    ).toBe('bedrock');
  });

  test('session setting takes top priority over all others', () => {
    expect(
      resolveInferenceMode({
        sessionInferenceMode: 'kiro-cli',
        customAgentInferenceMode: 'bedrock',
        envInferenceMode: 'bedrock',
      })
    ).toBe('kiro-cli');
  });

  test('session setting wins even when all other sources say kiro-cli and session says bedrock', () => {
    expect(
      resolveInferenceMode({
        sessionInferenceMode: 'bedrock',
        customAgentInferenceMode: 'kiro-cli',
        envInferenceMode: 'kiro-cli',
      })
    ).toBe('bedrock');
  });

  test('session undefined falls through to custom agent', () => {
    expect(
      resolveInferenceMode({
        sessionInferenceMode: undefined,
        customAgentInferenceMode: 'kiro-cli',
      })
    ).toBe('kiro-cli');
  });

  test('legacy session (no inferenceMode, no customAgent override) stays on bedrock regardless of future preference changes', () => {
    // This is the regression test for the fix: a pre-Kiro session must NOT
    // flip to Kiro just because the user later set their preference to Kiro.
    // Preferences are not part of the resolution context at all.
    expect(
      resolveInferenceMode({
        sessionInferenceMode: undefined,
        customAgentInferenceMode: undefined,
      })
    ).toBe('bedrock');
  });

  test('session setting wins even when custom agent is undefined', () => {
    expect(
      resolveInferenceMode({
        sessionInferenceMode: 'kiro-cli',
        customAgentInferenceMode: undefined,
        envInferenceMode: undefined,
      })
    ).toBe('kiro-cli');
  });
});

describe('normalizeMcpImageFormat', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('maps image/png to "png"', () => {
    expect(normalizeMcpImageFormat('image/png')).toBe('png');
  });

  test('maps image/jpeg to "jpeg"', () => {
    expect(normalizeMcpImageFormat('image/jpeg')).toBe('jpeg');
  });

  test('normalises image/jpg (non-standard alias) to "jpeg"', () => {
    // Bedrock's `format` enum does not include 'jpg'; the alias must be
    // rewritten or Converse rejects the turn.
    expect(normalizeMcpImageFormat('image/jpg')).toBe('jpeg');
  });

  test('maps image/gif and image/webp verbatim', () => {
    expect(normalizeMcpImageFormat('image/gif')).toBe('gif');
    expect(normalizeMcpImageFormat('image/webp')).toBe('webp');
  });

  test('is case-insensitive (IMAGE/PNG → "png")', () => {
    expect(normalizeMcpImageFormat('IMAGE/PNG')).toBe('png');
    expect(normalizeMcpImageFormat('Image/JPEG')).toBe('jpeg');
  });

  test('falls back to "jpeg" + warn log for unsupported subtype (image/svg+xml)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(normalizeMcpImageFormat('image/svg+xml')).toBe('jpeg');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('image/svg+xml');
  });

  test('falls back to "jpeg" + warn log for undefined / empty input', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(normalizeMcpImageFormat(undefined)).toBe('jpeg');
    expect(normalizeMcpImageFormat('')).toBe('jpeg');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  test('accepts bare subtype without "/" separator as best-effort passthrough', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Some broken MCP tools might report just "png" without the "image/"
    // prefix. The implementation falls back to treating the raw string as
    // the subtype and passes it through when it matches a known value, so
    // no warn is emitted in this case. (If anyone tightens this to require
    // "image/<subtype>", update both the implementation and this test.)
    expect(normalizeMcpImageFormat('png')).toBe('png');
    expect(warn).toHaveBeenCalledTimes(0);
  });
});

describe('SKILL_PATH_RE activation detection', () => {
  const SKILL_PATH_RE = /^\/tmp\/skills\/([a-zA-Z0-9_-]+)\/SKILL\.md$/;

  test('matches valid skill paths', () => {
    expect(SKILL_PATH_RE.test('/tmp/skills/abc123/SKILL.md')).toBe(true);
    expect(SKILL_PATH_RE.test('/tmp/skills/my-skill_01/SKILL.md')).toBe(true);
    expect(SKILL_PATH_RE.test('/tmp/skills/A1b2C3/SKILL.md')).toBe(true);
  });

  test('extracts skillId from path', () => {
    const match = SKILL_PATH_RE.exec('/tmp/skills/abc123/SKILL.md');
    expect(match?.[1]).toBe('abc123');
  });

  test('rejects paths not under /tmp/skills/', () => {
    expect(SKILL_PATH_RE.test('/home/user/skills/abc123/SKILL.md')).toBe(false);
    expect(SKILL_PATH_RE.test('/tmp/other/abc123/SKILL.md')).toBe(false);
  });

  test('rejects paths with subdirectories', () => {
    expect(SKILL_PATH_RE.test('/tmp/skills/abc123/sub/SKILL.md')).toBe(false);
  });

  test('rejects non-SKILL.md files', () => {
    expect(SKILL_PATH_RE.test('/tmp/skills/abc123/README.md')).toBe(false);
    expect(SKILL_PATH_RE.test('/tmp/skills/abc123/skill.md')).toBe(false);
  });

  test('rejects path traversal attempts', () => {
    expect(SKILL_PATH_RE.test('/tmp/skills/../etc/passwd/SKILL.md')).toBe(false);
    expect(SKILL_PATH_RE.test('/tmp/skills/abc123/../other/SKILL.md')).toBe(false);
  });

  test('rejects skillIds with special characters', () => {
    expect(SKILL_PATH_RE.test('/tmp/skills/abc 123/SKILL.md')).toBe(false);
    expect(SKILL_PATH_RE.test('/tmp/skills/abc/123/SKILL.md')).toBe(false);
    expect(SKILL_PATH_RE.test('/tmp/skills/abc.123/SKILL.md')).toBe(false);
  });

  test('false positive: read tool with non-skill path does not match', () => {
    expect(SKILL_PATH_RE.test('/tmp/workspace/SKILL.md')).toBe(false);
    expect(SKILL_PATH_RE.test('/tmp/skills/SKILL.md')).toBe(false);
  });
});

describe('emptyFinalMessageNotification', () => {
  test('content_filtered returns an explicit user-facing explanation', () => {
    const msg = emptyFinalMessageNotification('content_filtered', '');
    expect(msg).toContain('content filter');
    expect(msg).toContain('content_filtered');
    expect(msg.length).toBeGreaterThan(0);
  });

  test('content_filtered prepends the slack mention', () => {
    const msg = emptyFinalMessageNotification('content_filtered', '<@U123> ');
    expect(msg.startsWith('<@U123> ')).toBe(true);
    expect(msg).toContain('content filter');
  });

  test('benign empty end_turn only forwards the mention (no content-filter text)', () => {
    expect(emptyFinalMessageNotification('end_turn', '<@U123> ')).toBe('<@U123> ');
    expect(emptyFinalMessageNotification('end_turn', '<@U123> ')).not.toContain('content filter');
  });

  test('undefined stopReason only forwards the mention', () => {
    expect(emptyFinalMessageNotification(undefined, '')).toBe('');
  });
});

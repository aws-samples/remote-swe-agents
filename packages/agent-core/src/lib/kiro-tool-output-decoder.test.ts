import { describe, it, expect } from 'vitest';
import { decodeKiroToolOutput } from './kiro-tool-output-decoder';

describe('decodeKiroToolOutput — v2 (items[] Rust enum)', () => {
  it('decodes execute_bash Json shape (stdout + stderr), suppressing exit status 0', () => {
    // Real observed v2 shape (PoC #7). stdout and stderr are joined with '\n',
    // and stdout itself ends in '\n', so the result is 'hello\n' + '\n' + 'err\n'.
    const raw = { items: [{ Json: { exit_status: 'exit status: 0', stdout: 'hello\n', stderr: 'err\n' } }] };
    expect(decodeKiroToolOutput(raw)).toBe('hello\n\nerr\n');
  });

  it('surfaces a non-zero exit status marker', () => {
    const raw = { items: [{ Json: { exit_status: 'exit status: 2', stdout: 'out', stderr: '' } }] };
    expect(decodeKiroToolOutput(raw)).toBe('out\n[exit status: 2]');
  });

  it('decodes a Text variant', () => {
    expect(decodeKiroToolOutput({ items: [{ Text: 'file contents' }] })).toBe('file contents');
  });

  it('decodes an MCP content[] Json shape', () => {
    const raw = { items: [{ Json: { content: [{ type: 'text', text: 'mcp result' }] } }] };
    expect(decodeKiroToolOutput(raw)).toBe('mcp result');
  });

  it('surfaces MCP isError marker', () => {
    const raw = { items: [{ Json: { content: [{ type: 'text', text: 'boom' }], isError: true } }] };
    expect(decodeKiroToolOutput(raw)).toBe('boom\n[MCP tool reported isError=true]');
  });

  it('returns "" for a successful no-output command (empty stdout/stderr, exit 0)', () => {
    const raw = { items: [{ Json: { exit_status: 'exit status: 0', stdout: '', stderr: '' } }] };
    expect(decodeKiroToolOutput(raw)).toBe('');
  });

  it('returns "" for an MCP void response (content: [])', () => {
    const raw = { items: [{ Json: { content: [] } }] };
    expect(decodeKiroToolOutput(raw)).toBe('');
  });

  it('returns undefined for an empty items[]', () => {
    expect(decodeKiroToolOutput({ items: [] })).toBeUndefined();
  });

  it('joins multiple items with newlines', () => {
    const raw = { items: [{ Text: 'a' }, { Text: 'b' }] };
    expect(decodeKiroToolOutput(raw)).toBe('a\nb');
  });

  it('serialises an unknown Json shape rather than dropping it', () => {
    const raw = { items: [{ Json: { weird: 'shape', n: 1 } }] };
    expect(decodeKiroToolOutput(raw)).toBe('{"weird":"shape","n":1}');
  });

  it('handles the legacy flat { Text } shape', () => {
    expect(decodeKiroToolOutput({ Text: 'flat' })).toBe('flat');
  });
});

describe('decodeKiroToolOutput — v3 (KAS flat shape)', () => {
  it('decodes the real observed v3 shape, preferring output', () => {
    // Real observed v3 shape (PoC #7).
    const raw = { output: 'hello\nerr\n', exitCode: 0, message: 'Output:\nhello\nerr\n\n\nExit Code: 0' };
    expect(decodeKiroToolOutput(raw)).toBe('hello\nerr\n');
  });

  it('appends a non-zero exit code marker to output', () => {
    const raw = { output: 'partial', exitCode: 2, message: 'Output:\npartial\n\nExit Code: 2' };
    expect(decodeKiroToolOutput(raw)).toBe('partial\n[exit code: 2]');
  });

  it('does not append a marker for exit code 0', () => {
    const raw = { output: 'ok', exitCode: 0 };
    expect(decodeKiroToolOutput(raw)).toBe('ok');
  });

  it('falls back to message when output is absent', () => {
    const raw = { exitCode: 0, message: 'rendered block' };
    expect(decodeKiroToolOutput(raw)).toBe('rendered block');
  });

  it('returns "" for empty output with exit 0', () => {
    expect(decodeKiroToolOutput({ output: '', exitCode: 0 })).toBe('');
  });

  it('returns an exit-code marker for a bare non-zero exit with no output/message', () => {
    expect(decodeKiroToolOutput({ exitCode: 1 })).toBe('[exit code: 1]');
  });

  it('does not misclassify a v2 items[] wrapper as v3', () => {
    // Even if some future item carried an exitCode-looking key, the items[]
    // array is the v2 discriminator.
    const raw = { items: [{ Json: { exit_status: 'exit status: 0', stdout: 'x', stderr: '' } }] };
    expect(decodeKiroToolOutput(raw)).toBe('x');
  });
});

describe('decodeKiroToolOutput — edge cases', () => {
  it('returns undefined for undefined/null', () => {
    expect(decodeKiroToolOutput(undefined)).toBeUndefined();
    expect(decodeKiroToolOutput(null)).toBeUndefined();
  });

  it('returns undefined for an empty object', () => {
    expect(decodeKiroToolOutput({})).toBeUndefined();
  });

  it('passes through a bare string', () => {
    expect(decodeKiroToolOutput('raw string')).toBe('raw string');
  });

  it('returns undefined for a non-object primitive', () => {
    expect(decodeKiroToolOutput(42)).toBeUndefined();
  });
});

import { describe, expect, test } from 'vitest';
import { buildAttachmentSentinel, parseAttachmentSentinel } from './index';

describe('attachment sentinel', () => {
  test('round-trips key and isImage flags', () => {
    const payload = { key: 'worker-1/tool-2/foo bar.zip', isImage: false };
    const s = buildAttachmentSentinel(payload);
    expect(parseAttachmentSentinel(s)).toEqual(payload);

    const imgPayload = { key: 'worker-1/tool-3/pic.png', isImage: true };
    expect(parseAttachmentSentinel(buildAttachmentSentinel(imgPayload))).toEqual(imgPayload);
  });

  test('embeds sentinel inline with surrounding text', () => {
    const payload = { key: 'w/t/f.zip', isImage: false };
    const text = `successfully sent a file.\n${buildAttachmentSentinel(payload)}`;
    expect(parseAttachmentSentinel(text)).toEqual(payload);
  });

  test('returns undefined for missing or malformed input', () => {
    expect(parseAttachmentSentinel(undefined)).toBeUndefined();
    expect(parseAttachmentSentinel(null)).toBeUndefined();
    expect(parseAttachmentSentinel('')).toBeUndefined();
    expect(parseAttachmentSentinel('no sentinel here')).toBeUndefined();
    expect(parseAttachmentSentinel('<!--remote-swe-attachment:not_base64_$-->')).toBeUndefined();
    // Passes the outer regex (single char in [A-Za-z0-9_-]) but decodes
    // to an empty buffer so JSON.parse throws — exercises the
    // try/catch path that the regex-reject cases above skip.
    expect(parseAttachmentSentinel('<!--remote-swe-attachment:A-->')).toBeUndefined();
  });

  test('ignores payloads missing required fields', () => {
    const bad = `<!--remote-swe-attachment:${Buffer.from('{"key":"x"}').toString('base64url')}-->`;
    expect(parseAttachmentSentinel(bad)).toBeUndefined();
  });

  test('survives filenames containing HTML-comment-like fragments', () => {
    // A user-controlled filePath could contain `-->` or `<!--` but the
    // payload is base64url-encoded JSON, so the outer delimiters cannot
    // be terminated early.
    const payload = { key: 'w/t/evil<!-- -->.zip', isImage: false };
    const s = buildAttachmentSentinel(payload);
    expect(s.split('-->').length).toBe(2); // exactly one closing delimiter
    expect(parseAttachmentSentinel(s)).toEqual(payload);
  });

  test('handles multibyte UTF-8 filenames end-to-end', () => {
    // The Web-standard encoder path (TextEncoder → btoa) has to carry
    // UTF-8 round-trip, otherwise real-world filenames like 画像.png or
    // 猫.zip would silently corrupt between backend (Node) and webapp
    // (browser). This is the regression guard for that promise.
    const cases = [
      { key: 'worker-1/t/画像.png', isImage: true },
      { key: 'worker-1/t/レポート.pdf', isImage: false },
      { key: 'worker-1/t/café 🐈.zip', isImage: false },
      { key: 'worker-1/t/\u0000control\u0001chars.bin', isImage: false },
    ];
    for (const payload of cases) {
      expect(parseAttachmentSentinel(buildAttachmentSentinel(payload))).toEqual(payload);
    }
  });

  test('is wire-format compatible with the Node Buffer encoder', () => {
    // The first cut of this PR used `Buffer.from(...).toString('base64url')`.
    // Any persisted tool-result rows produced by that code path MUST keep
    // parsing through the isomorphic parser, otherwise rolling the webapp
    // forward would silently drop attachment links on live sessions.
    const payload = { key: 'worker-1/tool-42/legacy.zip', isImage: false };
    const nodeSentinel = `<!--remote-swe-attachment:${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}-->`;
    expect(parseAttachmentSentinel(nodeSentinel)).toEqual(payload);

    // And conversely: what the isomorphic encoder emits must still decode
    // via Node's Buffer, so the webapp ↔ backend contract is symmetric.
    const ourSentinel = buildAttachmentSentinel(payload);
    const inner = ourSentinel.match(/<!--remote-swe-attachment:([A-Za-z0-9_-]+)-->/)![1];
    expect(JSON.parse(Buffer.from(inner, 'base64url').toString('utf8'))).toEqual(payload);
  });
});

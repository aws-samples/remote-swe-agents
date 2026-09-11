import { getQueryParam, removeQueryParam } from '../lib/constructs/preview/lambda/origin-request';

const TOKEN = '__preview_token';

describe('removeQueryParam (preview origin-request query string handling)', () => {
  // Regression guard for the white-screen bug: the origin-request L@E must NOT
  // turn a bare `lang.css` flag into `lang.css=`. Slidev/Vite serve style blocks
  // as JS modules at URLs ending in `&lang.css` and rely on the trailing `.css`
  // to decide the response variant. A trailing `=` makes Vite return a CSS body
  // with a text/javascript content-type, breaking module loading.
  it('preserves a trailing bare `lang.css` flag (does NOT append `=`)', () => {
    const qs = 'vue&type=style&index=0&scoped=f5ee02a7&lang.css';
    expect(removeQueryParam(qs, TOKEN)).toBe(qs);
    expect(removeQueryParam(qs, TOKEN).endsWith('lang.css')).toBe(true);
    expect(removeQueryParam(qs, TOKEN)).not.toContain('lang.css=');
  });

  it('removes the token at the end (value form) and keeps order', () => {
    expect(removeQueryParam('vue&type=style&lang.css&__preview_token=abc.def', TOKEN)).toBe('vue&type=style&lang.css');
  });

  it('removes the token at the start', () => {
    expect(removeQueryParam('__preview_token=abc.def&vue&type=style&lang.css', TOKEN)).toBe('vue&type=style&lang.css');
  });

  it('removes the token in the middle', () => {
    expect(removeQueryParam('vue&__preview_token=abc.def&type=style&lang.css', TOKEN)).toBe('vue&type=style&lang.css');
  });

  it('returns empty string when the token is the only parameter', () => {
    expect(removeQueryParam('__preview_token=abc.def', TOKEN)).toBe('');
  });

  it('returns empty string for an empty query string', () => {
    expect(removeQueryParam('', TOKEN)).toBe('');
  });

  it('leaves normal params (including bare flags) untouched when no token present', () => {
    expect(removeQueryParam('a=1&b=2&c', TOKEN)).toBe('a=1&b=2&c');
  });

  it('preserves URL-encoded values of other params', () => {
    expect(removeQueryParam('redirect=%2Ffoo%2Fbar&__preview_token=x.y&q=a%20b', TOKEN)).toBe(
      'redirect=%2Ffoo%2Fbar&q=a%20b'
    );
  });

  it('preserves casing of other params', () => {
    expect(removeQueryParam('Vue&Type=Style&LANG.css&__preview_token=x.y', TOKEN)).toBe('Vue&Type=Style&LANG.css');
  });

  it('does not remove a lookalike key that merely shares the prefix', () => {
    expect(removeQueryParam('__preview_token_other=1&__preview_token=x.y&a=2', TOKEN)).toBe(
      '__preview_token_other=1&a=2'
    );
  });

  it('handles a token value that itself contains `=` characters', () => {
    expect(removeQueryParam('a=1&__preview_token=aaa=bbb=ccc&b=2', TOKEN)).toBe('a=1&b=2');
  });

  it('preserves empty (`&&`) segments in the remaining query string', () => {
    // The token is stripped; adjacent empty segments from the original are left as-is.
    expect(removeQueryParam('a=1&&__preview_token=x.y&&b=2', TOKEN)).toBe('a=1&&&b=2');
  });
});

describe('getQueryParam (preview origin-request query string handling)', () => {
  it('returns the decoded value of a param', () => {
    expect(getQueryParam('a=1&__preview_token=abc.def&b=2', TOKEN)).toBe('abc.def');
  });

  it('returns empty string for a bare flag', () => {
    expect(getQueryParam('a=1&__preview_token&b=2', TOKEN)).toBe('');
  });

  it('returns null when the param is absent', () => {
    expect(getQueryParam('a=1&b=2', TOKEN)).toBeNull();
  });

  it('returns null for an empty query string', () => {
    expect(getQueryParam('', TOKEN)).toBeNull();
  });

  it('decodes a URL-encoded value', () => {
    expect(getQueryParam('__preview_token=a%2Eb', TOKEN)).toBe('a.b');
  });

  it('reads a token value containing `=` characters verbatim (first `=` splits key/value)', () => {
    expect(getQueryParam('__preview_token=aaa=bbb', TOKEN)).toBe('aaa=bbb');
  });
});

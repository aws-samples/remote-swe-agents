import { describe, expect, test } from 'vitest';
import {
  isEndOfTurnPlaceholder,
  isScaffoldingArtifact,
  stripScaffoldingPrefix,
  sanitiseForDelivery,
  isInterruptPlaceholder,
} from './placeholder-detection';

// Unit tests for the shared detectors live here (agent-core) because the
// module is the single source of truth consumed by BOTH delivery paths:
//   - worker `finalizeTurn` (re-exports from ./orchestrator)
//   - agent-core `sendMessageToUser` tool (imports sanitiseForDelivery)
// The worker orchestrator.test.ts keeps its own tests asserting the
// re-export flow; this file asserts the underlying semantics.

describe('isEndOfTurnPlaceholder', () => {
  test('undefined / null / empty / whitespace are placeholders', () => {
    expect(isEndOfTurnPlaceholder(undefined)).toBe(true);
    expect(isEndOfTurnPlaceholder(null)).toBe(true);
    expect(isEndOfTurnPlaceholder('')).toBe(true);
    expect(isEndOfTurnPlaceholder('   ')).toBe(true);
    expect(isEndOfTurnPlaceholder('\n\n')).toBe(true);
    expect(isEndOfTurnPlaceholder('\t \n')).toBe(true);
  });

  test('1-3 dots are placeholders', () => {
    expect(isEndOfTurnPlaceholder('.')).toBe(true);
    expect(isEndOfTurnPlaceholder('..')).toBe(true);
    expect(isEndOfTurnPlaceholder('...')).toBe(true);
    expect(isEndOfTurnPlaceholder(' . ')).toBe(true);
  });

  test('single punctuation / symbol is a placeholder', () => {
    expect(isEndOfTurnPlaceholder(',')).toBe(true);
    expect(isEndOfTurnPlaceholder(';')).toBe(true);
    expect(isEndOfTurnPlaceholder('_')).toBe(true);
    expect(isEndOfTurnPlaceholder('-')).toBe(true);
  });

  test('invisible unicode wrapping a placeholder is still a placeholder', () => {
    expect(isEndOfTurnPlaceholder('\u200b.')).toBe(true);
    expect(isEndOfTurnPlaceholder('.\u200b')).toBe(true);
    expect(isEndOfTurnPlaceholder('\u200c.')).toBe(true);
    expect(isEndOfTurnPlaceholder('\u200d.')).toBe(true);
    expect(isEndOfTurnPlaceholder(' \u2060 . ')).toBe(true);
    expect(isEndOfTurnPlaceholder('\ufeff.')).toBe(true);
    expect(isEndOfTurnPlaceholder('\u200b')).toBe(true);
    expect(isEndOfTurnPlaceholder('\t\u200b\n')).toBe(true);
  });

  test('short real words are NOT placeholders', () => {
    expect(isEndOfTurnPlaceholder('ok')).toBe(false);
    expect(isEndOfTurnPlaceholder('done')).toBe(false);
    expect(isEndOfTurnPlaceholder('4')).toBe(false);
    expect(isEndOfTurnPlaceholder('Done.')).toBe(false);
    expect(isEndOfTurnPlaceholder('hello')).toBe(false);
    expect(isEndOfTurnPlaceholder('\u200bok')).toBe(false);
    expect(isEndOfTurnPlaceholder('ok\u200b')).toBe(false);
    expect(isEndOfTurnPlaceholder('\ufeffdone.')).toBe(false);
    expect(isEndOfTurnPlaceholder('4\u200b')).toBe(false);
  });

  test('4+ dots are NOT placeholders (out of scope)', () => {
    expect(isEndOfTurnPlaceholder('....')).toBe(false);
  });
});

// Some cases use Japanese scaffolding tags (e.g. "<続きは以下のツール呼び出しで>",
// meaning "<continued in the following tool call>") on purpose: the backend
// emits such tags in the agent's working language, so detecting the non-ASCII
// form is part of the system-under-test, not incidental example text.
describe('isScaffoldingArtifact', () => {
  test('whole-message single <...> block is an artifact', () => {
    expect(isScaffoldingArtifact('<続きは以下のツール呼び出しで>')).toBe(true);
    expect(isScaffoldingArtifact('<continue with more info>')).toBe(true);
    expect(isScaffoldingArtifact('<loading>')).toBe(true);
    expect(isScaffoldingArtifact('<n>')).toBe(true);
    expect(isScaffoldingArtifact('  <continue>  ')).toBe(true);
    expect(isScaffoldingArtifact('\u200b<continue>\u200b')).toBe(true);
  });

  test('messages with nested <>, newlines, or body are NOT artifacts', () => {
    expect(isScaffoldingArtifact('<html><body>x</body></html>')).toBe(false);
    expect(isScaffoldingArtifact('<a\nb>')).toBe(false);
    expect(isScaffoldingArtifact('<continue>hello')).toBe(false);
    expect(isScaffoldingArtifact('')).toBe(false);
    expect(isScaffoldingArtifact(undefined)).toBe(false);
    expect(isScaffoldingArtifact(null)).toBe(false);
    expect(isScaffoldingArtifact('<continue')).toBe(false);
    expect(isScaffoldingArtifact('<' + 'a'.repeat(101) + '>')).toBe(false);
  });

  test('does not misidentify short real replies', () => {
    expect(isScaffoldingArtifact('ok')).toBe(false);
    expect(isScaffoldingArtifact('done.')).toBe(false);
    expect(isScaffoldingArtifact('4')).toBe(false);
  });
});

describe('stripScaffoldingPrefix', () => {
  test('strips a keyword-matching leading <...> block and delivers the remainder', () => {
    expect(stripScaffoldingPrefix('<続きは以下のツール呼び出しで>中間報告です')).toBe('中間報告です');
    expect(stripScaffoldingPrefix('<continue with more info>some message')).toBe('some message');
    expect(stripScaffoldingPrefix('<next step> hello')).toBe('hello');
    expect(stripScaffoldingPrefix('<続き> Summary: done.')).toBe('Summary: done.');
    expect(stripScaffoldingPrefix('<続き>報告します')).toBe('報告します');
  });

  test('does NOT strip legitimate markup (keyword gate)', () => {
    expect(stripScaffoldingPrefix('<html><body>hello</body></html>')).toBe('<html><body>hello</body></html>');
    expect(stripScaffoldingPrefix('<div> tag is useful')).toBe('<div> tag is useful');
    expect(stripScaffoldingPrefix('<strong>emphasis</strong>')).toBe('<strong>emphasis</strong>');
    expect(stripScaffoldingPrefix('<?xml version="1.0"?> metadata')).toBe('<?xml version="1.0"?> metadata');
  });

  test('no leading <...> -> pass-through', () => {
    expect(stripScaffoldingPrefix('hello world')).toBe('hello world');
    expect(stripScaffoldingPrefix('')).toBe('');
    expect(stripScaffoldingPrefix('Summary: Use <continue> somewhere mid-text')).toBe(
      'Summary: Use <continue> somewhere mid-text'
    );
    expect(stripScaffoldingPrefix(' <continue>text')).toBe(' <continue>text');
  });

  test('keyword gate is the only safety', () => {
    // Non-keyword inner is always pass-through even with ambiguous boundary
    expect(stripScaffoldingPrefix('<div>42text')).toBe('<div>42text');
    expect(stripScaffoldingPrefix('<span>text')).toBe('<span>text');
    // Keyword inner strips regardless of the character after `>`
    expect(stripScaffoldingPrefix('<continue>42text')).toBe('42text');
    expect(stripScaffoldingPrefix('<continue>some message')).toBe('some message');
  });
});

describe('sanitiseForDelivery', () => {
  test('returns shouldSend:false for placeholders', () => {
    expect(sanitiseForDelivery('')).toEqual({ shouldSend: false });
    expect(sanitiseForDelivery('.')).toEqual({ shouldSend: false });
    expect(sanitiseForDelivery('...')).toEqual({ shouldSend: false });
    expect(sanitiseForDelivery('\u200b.')).toEqual({ shouldSend: false });
    expect(sanitiseForDelivery('   ')).toEqual({ shouldSend: false });
    expect(sanitiseForDelivery(',')).toEqual({ shouldSend: false });
  });

  test('returns shouldSend:false for whole-message scaffolding artifacts', () => {
    expect(sanitiseForDelivery('<続きは以下のツール呼び出しで>')).toEqual({ shouldSend: false });
    expect(sanitiseForDelivery('<continue with more info>')).toEqual({ shouldSend: false });
    expect(sanitiseForDelivery('  <next step>  ')).toEqual({ shouldSend: false });
  });

  test('returns shouldSend:false when scaffolding prefix leaves only a placeholder', () => {
    expect(sanitiseForDelivery('<続き> .')).toEqual({ shouldSend: false });
    expect(sanitiseForDelivery('<continue> ')).toEqual({ shouldSend: false });
  });

  test('returns stripped body when scaffolding prefix wraps a real message', () => {
    expect(sanitiseForDelivery('<続きは以下のツール呼び出しで>中間報告です')).toEqual({
      shouldSend: true,
      message: '中間報告です',
    });
    expect(sanitiseForDelivery('<continue with more info>some message')).toEqual({
      shouldSend: true,
      message: 'some message',
    });
  });

  test('returns shouldSend:true with original body for legitimate messages', () => {
    expect(sanitiseForDelivery('ok')).toEqual({ shouldSend: true, message: 'ok' });
    expect(sanitiseForDelivery('Done.')).toEqual({ shouldSend: true, message: 'Done.' });
    expect(sanitiseForDelivery('Summary: pushed to branch foo')).toEqual({
      shouldSend: true,
      message: 'Summary: pushed to branch foo',
    });
    expect(sanitiseForDelivery('<html><body>hi</body></html>')).toEqual({
      shouldSend: true,
      message: '<html><body>hi</body></html>',
    });
    expect(sanitiseForDelivery('Use <strong> for emphasis')).toEqual({
      shouldSend: true,
      message: 'Use <strong> for emphasis',
    });
  });
});

describe('isInterruptPlaceholder', () => {
  test('detects the canonical inference cancel placeholder', () => {
    expect(isInterruptPlaceholder('Response was interrupted by the user')).toBe(true);
    expect(isInterruptPlaceholder('Response was interrupted by the user.')).toBe(true);
  });

  test('case-insensitive matching', () => {
    expect(isInterruptPlaceholder('response was interrupted by the user')).toBe(true);
    expect(isInterruptPlaceholder('RESPONSE WAS INTERRUPTED BY THE USER')).toBe(true);
    expect(isInterruptPlaceholder('Response Was Interrupted By The User.')).toBe(true);
  });

  test('tolerates surrounding whitespace and invisible unicode', () => {
    expect(isInterruptPlaceholder('  Response was interrupted by the user  ')).toBe(true);
    expect(isInterruptPlaceholder('\u200bResponse was interrupted by the user\u200b')).toBe(true);
    expect(isInterruptPlaceholder('\n Response was interrupted by the user. \n')).toBe(true);
  });

  test('does NOT match partial embeds or longer messages', () => {
    expect(isInterruptPlaceholder('Response was interrupted by the user and something else')).toBe(false);
    expect(isInterruptPlaceholder('The response was interrupted by the user')).toBe(false);
    expect(isInterruptPlaceholder('foo Response was interrupted by the user bar')).toBe(false);
  });

  test('null / undefined / empty returns false', () => {
    expect(isInterruptPlaceholder(null)).toBe(false);
    expect(isInterruptPlaceholder(undefined)).toBe(false);
    expect(isInterruptPlaceholder('')).toBe(false);
  });

  test('does NOT match normal messages', () => {
    expect(isInterruptPlaceholder('I completed the task')).toBe(false);
    expect(isInterruptPlaceholder('ok')).toBe(false);
    expect(isInterruptPlaceholder('The user interrupted the process')).toBe(false);
  });
});

describe('sanitiseForDelivery — interrupt placeholder integration', () => {
  test('returns shouldSend:false for interrupt placeholders', () => {
    expect(sanitiseForDelivery('Response was interrupted by the user')).toEqual({ shouldSend: false });
    expect(sanitiseForDelivery('Response was interrupted by the user.')).toEqual({ shouldSend: false });
  });
});

import { describe, expect, it } from 'vitest';
import {
  findPortMatches,
  isPortOpen,
  rewriteLocalhostUrls,
  rewriteMdastLocalhostUrls,
  type MdastNode,
  type PortMapping,
} from './port-url-transform';

const HOSTNAME = 'ec2-1-2-3-4.compute.amazonaws.com';

const mapping = (ports: Array<[number, number?]>): PortMapping => ({
  hostname: HOSTNAME,
  openedPorts: ports.map(([from, to]) => ({
    fromPort: from,
    toPort: to ?? from,
    cidr: '1.2.3.4/32',
    openedAt: 1,
  })),
});

describe('isPortOpen', () => {
  it('returns true when port is inside a range', () => {
    expect(isPortOpen(3005, [{ fromPort: 3000, toPort: 3010, cidr: 'x', openedAt: 0 }])).toBe(true);
  });
  it('returns false when port is outside', () => {
    expect(isPortOpen(3000, [{ fromPort: 4000, toPort: 4010, cidr: 'x', openedAt: 0 }])).toBe(false);
  });
  it('returns false on empty list', () => {
    expect(isPortOpen(3000, [])).toBe(false);
  });
});

describe('rewriteLocalhostUrls', () => {
  it('rewrites bare "localhost:PORT" when the port is open', () => {
    const out = rewriteLocalhostUrls('Visit localhost:3000 now.', mapping([[3000]]));
    expect(out).toBe(`Visit http://${HOSTNAME}:3000 now.`);
  });

  it('rewrites "127.0.0.1:PORT"', () => {
    const out = rewriteLocalhostUrls('Try 127.0.0.1:8080/api', mapping([[8080]]));
    expect(out).toBe(`Try http://${HOSTNAME}:8080/api`);
  });

  it('preserves explicit http:// scheme', () => {
    const out = rewriteLocalhostUrls('open http://localhost:3000/path', mapping([[3000]]));
    expect(out).toBe(`open http://${HOSTNAME}:3000/path`);
  });

  it('preserves https:// scheme', () => {
    const out = rewriteLocalhostUrls('open https://localhost:8443/x', mapping([[8443]]));
    expect(out).toBe(`open https://${HOSTNAME}:8443/x`);
  });

  it('rewrites URLs with query string and fragment', () => {
    const out = rewriteLocalhostUrls('http://localhost:3000/foo?a=1&b=2#frag', mapping([[3000]]));
    expect(out).toBe(`http://${HOSTNAME}:3000/foo?a=1&b=2#frag`);
  });

  it('leaves references to unopened ports untouched', () => {
    const out = rewriteLocalhostUrls('localhost:9999 is closed', mapping([[3000]]));
    expect(out).toBe('localhost:9999 is closed');
  });

  it('handles multiple references in one string', () => {
    const out = rewriteLocalhostUrls(
      'API: http://localhost:3000/ and docs at 127.0.0.1:6006',
      mapping([[3000], [6006]])
    );
    expect(out).toBe(`API: http://${HOSTNAME}:3000/ and docs at http://${HOSTNAME}:6006`);
  });

  it('returns input unchanged when no mapping is provided', () => {
    const input = 'visit localhost:3000';
    expect(rewriteLocalhostUrls(input, null)).toBe(input);
    expect(rewriteLocalhostUrls(input, undefined)).toBe(input);
    expect(
      rewriteLocalhostUrls(input, {
        hostname: undefined,
        openedPorts: [{ fromPort: 3000, toPort: 3000, cidr: '', openedAt: 0 }],
      })
    ).toBe(input);
  });

  it('returns input unchanged when the input is empty', () => {
    expect(rewriteLocalhostUrls('', mapping([[3000]]))).toBe('');
  });

  it('does not match bare "localhost" without a port', () => {
    const out = rewriteLocalhostUrls('run localhost locally', mapping([[3000]]));
    expect(out).toBe('run localhost locally');
  });

  it('stops matching at common trailing punctuation', () => {
    const out = rewriteLocalhostUrls('see localhost:3000, then localhost:3000.', mapping([[3000]]));
    // The trailing "," / "." must NOT be consumed into the replacement URL.
    expect(out).toBe(`see http://${HOSTNAME}:3000, then http://${HOSTNAME}:3000.`);
  });

  it('honors port ranges', () => {
    const out = rewriteLocalhostUrls('localhost:4005', mapping([[4000, 4010]]));
    expect(out).toBe(`http://${HOSTNAME}:4005`);
  });
});

describe('findPortMatches', () => {
  it('reports unopened matches without a replacement', () => {
    const matches = findPortMatches('localhost:3000 and localhost:4000', mapping([[3000]]));
    expect(matches).toHaveLength(2);
    expect(matches[0].port).toBe(3000);
    expect(matches[0].replacement).toBeDefined();
    expect(matches[1].port).toBe(4000);
    expect(matches[1].replacement).toBeUndefined();
  });

  it('is case-insensitive on the host token', () => {
    const matches = findPortMatches('LocalHost:3000', mapping([[3000]]));
    expect(matches).toHaveLength(1);
    expect(matches[0].replacement).toBe(`http://${HOSTNAME}:3000`);
  });
});

describe('rewriteMdastLocalhostUrls', () => {
  /**
   * Helper to build a minimal mdast root with a paragraph containing a single
   * text node. Mirrors what remark would produce for "foo".
   */
  const paragraph = (value: string): MdastNode => ({
    type: 'root',
    children: [
      {
        type: 'paragraph',
        children: [{ type: 'text', value }],
      },
    ],
  });

  it('rewrites plain text nodes into text + link nodes', () => {
    const tree = paragraph('visit localhost:3000 please');
    rewriteMdastLocalhostUrls(tree, mapping([[3000]]));

    const paraChildren = tree.children![0].children!;
    expect(paraChildren).toHaveLength(3);
    expect(paraChildren[0]).toEqual({ type: 'text', value: 'visit ' });
    expect(paraChildren[1]).toEqual({
      type: 'link',
      url: `http://${HOSTNAME}:3000`,
      children: [{ type: 'text', value: `http://${HOSTNAME}:3000` }],
    });
    expect(paraChildren[2]).toEqual({ type: 'text', value: ' please' });
  });

  it('does NOT descend into code (fenced) blocks', () => {
    const tree: MdastNode = {
      type: 'root',
      children: [{ type: 'code', lang: 'ts', value: 'fetch("http://localhost:3000/api")' }],
    };
    rewriteMdastLocalhostUrls(tree, mapping([[3000]]));

    // The code node itself is left alone — no splitting, no link injection.
    const code = tree.children![0];
    expect(code.type).toBe('code');
    expect(code.value).toBe('fetch("http://localhost:3000/api")');
    expect(code.children).toBeUndefined();
  });

  it('does NOT rewrite inlineCode spans', () => {
    const tree: MdastNode = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'text', value: 'run the server on ' },
            { type: 'inlineCode', value: 'localhost:3000' },
            { type: 'text', value: ' first' },
          ],
        },
      ],
    };
    rewriteMdastLocalhostUrls(tree, mapping([[3000]]));

    const paraChildren = tree.children![0].children!;
    // inlineCode is untouched, and the sibling text nodes don't contain
    // matchable localhost references, so the tree shape is identical.
    expect(paraChildren).toHaveLength(3);
    expect(paraChildren[1]).toEqual({ type: 'inlineCode', value: 'localhost:3000' });
  });

  it('rewrites text around a code block without touching the code block', () => {
    const tree: MdastNode = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'text', value: 'before localhost:3000' }],
        },
        { type: 'code', lang: 'ts', value: 'const u = "http://localhost:3000";' },
        {
          type: 'paragraph',
          children: [{ type: 'text', value: 'after 127.0.0.1:3000' }],
        },
      ],
    };
    rewriteMdastLocalhostUrls(tree, mapping([[3000]]));

    // First paragraph was rewritten
    const first = tree.children![0].children!;
    expect(first.some((n) => n.type === 'link')).toBe(true);

    // Code block was NOT rewritten and is still a leaf value node
    const code = tree.children![1];
    expect(code.type).toBe('code');
    expect(code.value).toBe('const u = "http://localhost:3000";');
    expect(code.children).toBeUndefined();

    // Third paragraph was rewritten
    const third = tree.children![2].children!;
    expect(third.some((n) => n.type === 'link')).toBe(true);
  });

  it('leaves the tree untouched when the port is not open', () => {
    const tree = paragraph('visit localhost:9999 please');
    const before = JSON.stringify(tree);
    rewriteMdastLocalhostUrls(tree, mapping([[3000]]));
    expect(JSON.stringify(tree)).toBe(before);
  });

  it('does nothing when mapping is null / empty', () => {
    const tree = paragraph('visit localhost:3000');
    const before = JSON.stringify(tree);
    rewriteMdastLocalhostUrls(tree, null);
    expect(JSON.stringify(tree)).toBe(before);

    rewriteMdastLocalhostUrls(tree, { hostname: HOSTNAME, openedPorts: [] });
    expect(JSON.stringify(tree)).toBe(before);
  });
});

describe('previewBaseUrl mode (MicroVM preview)', () => {
  const previewMapping = (port: number): PortMapping => ({
    previewBaseUrl: 'https://d123.cloudfront.net/worker-abc',
    openedPorts: [{ fromPort: port, toPort: port, cidr: '*', openedAt: 1 }],
  });

  describe('rewriteLocalhostUrls', () => {
    it('rewrites to preview base URL without port', () => {
      const out = rewriteLocalhostUrls('Visit localhost:3000 now.', previewMapping(3000));
      expect(out).toBe('Visit https://d123.cloudfront.net/worker-abc now.');
    });

    it('appends path to preview base URL', () => {
      const out = rewriteLocalhostUrls('http://localhost:3000/api/test', previewMapping(3000));
      expect(out).toBe('https://d123.cloudfront.net/worker-abc/api/test');
    });

    it('does not rewrite ports that are not open', () => {
      const out = rewriteLocalhostUrls('localhost:4000/x', previewMapping(3000));
      expect(out).toBe('localhost:4000/x');
    });

    it('prefers previewBaseUrl over hostname when both are set', () => {
      const mapping: PortMapping = {
        hostname: HOSTNAME,
        previewBaseUrl: 'https://d123.cloudfront.net/w',
        openedPorts: [{ fromPort: 3000, toPort: 3000, cidr: '*', openedAt: 1 }],
      };
      const out = rewriteLocalhostUrls('localhost:3000/', mapping);
      expect(out).toBe('https://d123.cloudfront.net/w/');
    });
  });

  describe('findPortMatches', () => {
    it('returns replacement using previewBaseUrl', () => {
      const matches = findPortMatches('localhost:3000/page', previewMapping(3000));
      expect(matches).toHaveLength(1);
      expect(matches[0].replacement).toBe('https://d123.cloudfront.net/worker-abc/page');
    });
  });

  describe('rewriteMdastLocalhostUrls', () => {
    const paragraph = (value: string): MdastNode => ({
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value }] }],
    });

    it('rewrites text nodes to link nodes with preview URL', () => {
      const tree = paragraph('open localhost:3000/dashboard');
      rewriteMdastLocalhostUrls(tree, previewMapping(3000));

      const paraChildren = tree.children![0].children!;
      expect(paraChildren.some((n) => n.type === 'link')).toBe(true);
      const link = paraChildren.find((n) => n.type === 'link')!;
      expect(link.url).toBe('https://d123.cloudfront.net/worker-abc/dashboard');
    });
  });
});

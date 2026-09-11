import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// agent-core's package.json `exports` map only points at the compiled `./dist`
// tree, which is not built during local/CI worker test runs. Alias the
// published subpaths to agent-core's TypeScript source so vitest can resolve
// (and transform) them without requiring a prior build step.
const agentCoreSrc = (subpath: string) => fileURLToPath(new URL(`../agent-core/src/${subpath}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: '@remote-swe-agents/agent-core/aws', replacement: agentCoreSrc('lib/aws/index.ts') },
      { find: '@remote-swe-agents/agent-core/lib', replacement: agentCoreSrc('lib/index.ts') },
      { find: '@remote-swe-agents/agent-core/schema', replacement: agentCoreSrc('schema/index.ts') },
      { find: '@remote-swe-agents/agent-core/tools', replacement: agentCoreSrc('tools/index.ts') },
      { find: '@remote-swe-agents/agent-core/mcp-server', replacement: agentCoreSrc('mcp-server/index.ts') },
    ],
  },
  test: {},
});

import type { InferenceBackend } from '@remote-swe-agents/agent-core/lib';
import { bedrockBackend } from './bedrock-backend';
import { kiroBackend } from './kiro-backend';

/**
 * Registry of every backend class the worker knows about. Consumers that need
 * to iterate all backends (e.g. the process signal handler, which must tear
 * down each backend's long-lived resources on shutdown) should use this list
 * so that adding a new backend only requires registering it here.
 */
export const allBackends: InferenceBackend[] = [bedrockBackend, kiroBackend];

export { bedrockBackend, kiroBackend };

/**
 * Dispose of every backend's long-lived resources. Invoked from the worker
 * process signal handler; must be safe to call multiple times.
 */
export const disposeAllBackends = async (): Promise<void> => {
  await Promise.all(
    allBackends.map(async (backend) => {
      if (typeof backend.dispose !== 'function') return;
      try {
        await backend.dispose();
      } catch (e) {
        console.error(`[backends] ${backend.kind}.dispose() failed:`, e);
      }
    })
  );
};

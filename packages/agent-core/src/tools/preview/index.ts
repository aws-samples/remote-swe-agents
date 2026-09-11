import { z } from 'zod';
import { ToolDefinition, zodToJsonSchemaBody } from '../../private/common/lib.js';
import {
  LambdaMicrovmsClient,
  RunMicrovmCommand,
  CreateMicrovmAuthTokenCommand,
  TerminateMicrovmCommand,
} from '@aws-sdk/client-lambda-microvms';
import { PutCommand, DeleteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TableName } from '../../lib/aws/ddb.js';
import { writeMetadata } from '../../lib/metadata.js';
import { sendWebappEvent } from '../../lib/events.js';
import { TunnelClient } from './tunnel-client.js';
import { getWebappOrigin } from '../../lib/webapp-origin.js';

const microvmsClient = new LambdaMicrovmsClient({});

const TUNNEL_PORT = 9000;
const PROXY_PORT = 8080;
const TOKEN_REFRESH_INTERVAL_MS = 45 * 60 * 1000; // 45 minutes
const TOKEN_EXPIRATION_MINUTES = 60;
const PREVIEW_TOKEN_PK_PREFIX = 'preview-token';

export const PREVIEW_METADATA_TAG = 'previewSession';

export type PreviewSessionMetadata = {
  microvmId: string;
  microvmEndpoint: string;
  previewUrl: string;
  localPort: number;
  startedAt: number;
};

let activePreview: {
  microvmId: string;
  microvmEndpoint: string;
  tunnelClient: TunnelClient;
  tokenRefreshTimer: NodeJS.Timeout;
  localPort: number;
  workerId: string;
} | null = null;

const getMicrovmImageArn = (): string => {
  const arn = process.env.PREVIEW_MICROVM_IMAGE_ARN;
  if (!arn) {
    throw new Error('PREVIEW_MICROVM_IMAGE_ARN is not set.');
  }
  return arn;
};

// Generate webapp handoff URL (Cognito-authenticated redirect to preview)
async function getPreviewHandoffUrl(workerId: string): Promise<string> {
  const webappOrigin = await getWebappOrigin();
  if (!webappOrigin) {
    throw new Error('WEBAPP_ORIGIN_NAME_PARAMETER is not configured');
  }
  return `${webappOrigin}/api/preview/handoff/${workerId}`;
}

async function storePreviewToken(workerId: string, microvmId: string, endpoint: string, token: string): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName,
      Item: {
        PK: `${PREVIEW_TOKEN_PK_PREFIX}-${workerId}`,
        SK: 'current',
        microvmId,
        endpoint,
        token,
        updatedAt: Date.now(),
        TTL: Math.floor(Date.now() / 1000) + 7200, // S4: use 'TTL' (matches DDB table definition)
      },
    })
  );
}

async function deletePreviewToken(workerId: string): Promise<void> {
  await ddb.send(
    new DeleteCommand({
      TableName,
      Key: {
        PK: `${PREVIEW_TOKEN_PK_PREFIX}-${workerId}`,
        SK: 'current',
      },
    })
  );
}

// S6: Scoped token for browser traffic (port 8080 only)
async function createBrowserAuthToken(microvmId: string): Promise<string> {
  const resp = await microvmsClient.send(
    new CreateMicrovmAuthTokenCommand({
      microvmIdentifier: microvmId,
      expirationInMinutes: TOKEN_EXPIRATION_MINUTES,
      allowedPorts: [{ port: PROXY_PORT }],
    })
  );

  const token = resp.authToken?.['X-aws-proxy-auth'];
  if (!token) {
    throw new Error('Failed to create MicroVM auth token: no token in response');
  }
  return token;
}

// S6: Scoped token for tunnel traffic (port 9000 only)
async function createTunnelAuthToken(microvmId: string): Promise<string> {
  const resp = await microvmsClient.send(
    new CreateMicrovmAuthTokenCommand({
      microvmIdentifier: microvmId,
      expirationInMinutes: TOKEN_EXPIRATION_MINUTES,
      allowedPorts: [{ port: TUNNEL_PORT }],
    })
  );

  const token = resp.authToken?.['X-aws-proxy-auth'];
  if (!token) {
    throw new Error('Failed to create MicroVM tunnel auth token: no token in response');
  }
  return token;
}

async function notifyPreviewUpdate(workerId: string, metadata: PreviewSessionMetadata | null): Promise<void> {
  try {
    await sendWebappEvent(workerId, {
      type: 'portsUpdate',
      hostname: metadata?.previewUrl,
      openedPorts: metadata
        ? [{ fromPort: metadata.localPort, toPort: metadata.localPort, cidr: '*', openedAt: metadata.startedAt }]
        : [],
    });
  } catch (e) {
    console.log(`Failed to notify preview update for ${workerId}: ${e}`);
  }
}

// S3: Check for existing preview state in DDB (crash recovery)
async function getExistingPreviewState(workerId: string): Promise<{ microvmId: string; endpoint: string } | null> {
  try {
    const result = await ddb.send(
      new GetCommand({
        TableName,
        Key: {
          PK: `${PREVIEW_TOKEN_PK_PREFIX}-${workerId}`,
          SK: 'current',
        },
      })
    );
    if (result.Item?.microvmId && result.Item?.endpoint) {
      return { microvmId: result.Item.microvmId, endpoint: result.Item.endpoint };
    }
  } catch {
    // ignore
  }
  return null;
}

// S3: Terminate orphaned MicroVM from previous crash
async function terminateOrphanedMicrovm(microvmId: string): Promise<void> {
  try {
    await microvmsClient.send(new TerminateMicrovmCommand({ microvmIdentifier: microvmId }));
    console.log(`[preview] Terminated orphaned MicroVM ${microvmId}`);
  } catch (e: any) {
    if (!e.name?.includes('NotFound')) {
      console.error(`[preview] Failed to terminate orphaned MicroVM ${microvmId}:`, e.message);
    }
  }
}

// --- openPreview ---

const openPreviewInputSchema = z.object({
  port: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .describe('The local port where the dev server is running (e.g. 3000 for Next.js, 5173 for Vite).'),
});

const openPreviewName = 'Open Preview';

export const openPreviewTool: ToolDefinition<z.infer<typeof openPreviewInputSchema>> = {
  name: openPreviewName,
  handler: async (input, context) => {
    const { workerId } = context;
    const { port } = input;

    // S3: Prevent double MicroVM
    if (activePreview) {
      return `Error: A preview session is already active (port ${activePreview.localPort}). Close it with closePreview first.`;
    }

    if (process.env.WORKER_RUNTIME !== 'agent-core') {
      return 'Error: openPreview is only available on AgentCore runtime.';
    }

    const imageArn = getMicrovmImageArn();

    // S3: Clean up orphaned preview from previous crash
    const existing = await getExistingPreviewState(workerId);
    if (existing) {
      await terminateOrphanedMicrovm(existing.microvmId);
      await deletePreviewToken(workerId);
    }

    let microvmId: string | undefined;

    try {
      // Step 1: Run the MicroVM
      const runResp = await microvmsClient.send(
        new RunMicrovmCommand({
          imageIdentifier: imageArn,
          ingressNetworkConnectors: [
            `arn:aws:lambda:${process.env.AWS_REGION}:aws:network-connector:aws-network-connector:ALL_INGRESS`,
          ],
          egressNetworkConnectors: [
            `arn:aws:lambda:${process.env.AWS_REGION}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`,
          ],
          idlePolicy: {
            autoResumeEnabled: true,
            maxIdleDurationSeconds: 900,
            suspendedDurationSeconds: 3600,
          },
          maximumDurationInSeconds: 28800,
        })
      );

      microvmId = runResp.microvmId;
      const endpoint = runResp.endpoint;

      if (!microvmId || !endpoint) {
        throw new Error('RunMicrovm returned no microvmId or endpoint');
      }

      // Step 2: Create scoped auth tokens (S6)
      const browserToken = await createBrowserAuthToken(microvmId);
      const tunnelToken = await createTunnelAuthToken(microvmId);

      // Step 3: Store browser token in DDB for L@E
      await storePreviewToken(workerId, microvmId, endpoint, browserToken);

      // Step 4: Establish WebSocket tunnel to MicroVM (with retry for boot race)
      const MAX_TUNNEL_CONNECT_RETRIES = 5;
      const INITIAL_TUNNEL_RETRY_DELAY_MS = 2000;
      let tunnelClient: TunnelClient | undefined;
      let tunnelConnectError: Error | undefined;
      for (let attempt = 0; attempt < MAX_TUNNEL_CONNECT_RETRIES; attempt++) {
        const client = new TunnelClient(endpoint, TUNNEL_PORT, port, tunnelToken, () => {
          console.log(`[preview] Tunnel disconnected for worker ${workerId}, scheduling reconnect`);
          scheduleReconnect(workerId);
        });
        try {
          await client.connect();
          tunnelClient = client;
          tunnelConnectError = undefined;
          break;
        } catch (e: any) {
          client.terminate();
          tunnelConnectError = e;
          const errMsg = (e.message ?? '').toLowerCase();
          const isRetryable =
            errMsg.includes('timeout') ||
            errMsg.includes('econnrefused') ||
            errMsg.includes('econnreset') ||
            errMsg.includes('etimedout') ||
            errMsg.includes('502') ||
            errMsg.includes('503');
          if (!isRetryable || attempt >= MAX_TUNNEL_CONNECT_RETRIES - 1) {
            break;
          }
          const delay = INITIAL_TUNNEL_RETRY_DELAY_MS * Math.pow(2, attempt);
          console.log(`[preview] Tunnel connect attempt ${attempt + 1} failed (${e.message}), retrying in ${delay}ms`);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
      if (tunnelConnectError || !tunnelClient) {
        throw tunnelConnectError ?? new Error('Tunnel connection failed');
      }

      // Step 5: Set up token refresh timer (S5: atomic refresh)
      const tokenRefreshTimer = setInterval(async () => {
        try {
          const newBrowserToken = await createBrowserAuthToken(microvmId!);
          await storePreviewToken(workerId, microvmId!, endpoint, newBrowserToken);

          const newTunnelToken = await createTunnelAuthToken(microvmId!);
          // S5: updateAuthToken handles atomic WS replacement (old connection kept until new is ready)
          tunnelClient.updateAuthToken(newTunnelToken);
          console.log(`[preview] Tokens refreshed for ${workerId}`);
        } catch (e) {
          console.error(`[preview] Token refresh failed for ${workerId}:`, e);
        }
      }, TOKEN_REFRESH_INTERVAL_MS);

      activePreview = {
        microvmId,
        microvmEndpoint: endpoint,
        tunnelClient,
        tokenRefreshTimer,
        localPort: port,
        workerId,
      };

      // Step 6: Persist metadata and generate handoff URL
      const previewUrl = await getPreviewHandoffUrl(workerId);
      const metadata: PreviewSessionMetadata = {
        microvmId,
        microvmEndpoint: endpoint,
        previewUrl,
        localPort: port,
        startedAt: Date.now(),
      };
      await writeMetadata(PREVIEW_METADATA_TAG, metadata, workerId);
      await notifyPreviewUpdate(workerId, metadata);

      return [
        `Preview opened successfully.`,
        `- Local port: ${port}`,
        `- MicroVM ID: ${microvmId}`,
        `- Preview URL: ${previewUrl}`,
        ``,
        `IMPORTANT: Share the Preview URL above with the user. NEVER tell them to open localhost:${port} or 127.0.0.1:${port} — those are unreachable from their browser.`,
        `The webapp automatically converts localhost:${port} mentions in your messages into clickable preview links, but always prefer giving the Preview URL directly.`,
        `Only one preview can be active in the user's browser at a time.`,
        `The preview will auto-suspend after 15 minutes of inactivity.`,
        `Use closePreview to terminate when done.`,
      ].join('\n');
    } catch (e: any) {
      // S1: Clean up MicroVM on failure at any step after RunMicrovm
      if (microvmId) {
        try {
          await microvmsClient.send(new TerminateMicrovmCommand({ microvmIdentifier: microvmId }));
        } catch {} // best effort
        try {
          await deletePreviewToken(workerId);
        } catch {} // best effort
      }
      activePreview = null;
      return `Error in openPreview: ${e.name ?? 'Error'}: ${e.message}`;
    }
  },
  schema: openPreviewInputSchema,
  toolSpec: async () => ({
    name: openPreviewName,
    description: `Open a public preview of a locally running dev server by establishing a tunnel through a Lambda MicroVM.

This creates a MicroVM that acts as a reverse proxy, establishing a WebSocket tunnel from this worker to the MicroVM. Browser traffic from the preview URL is forwarded through the tunnel to your local dev server.

The preview URL is protected by authentication via a handoff token. HMR/WebSocket connections are supported for hot-reload development workflows.

Requirements:
- A dev server must already be running on the specified port
- Only one preview session can be active at a time
- Only available on AgentCore runtime (not EC2)

The preview will auto-suspend after 15 minutes of idle and auto-terminate after 1 hour suspended. Use closePreview to terminate early.

This is the ONLY way to expose a local port to the user's browser. Do NOT use localtunnel, ngrok, or any other external tunneling service.`,
    inputSchema: {
      json: zodToJsonSchemaBody(openPreviewInputSchema),
    },
  }),
};

// S2: Reconnection logic — on-demand only (should-fix 5: avoid ingress that prevents idle suspend)
// Instead of eagerly reconnecting (which prevents MicroVM from suspending), we mark the tunnel
// as disconnected. The MicroVM will auto-resume on the next browser request (via CF → MicroVM ingress).
// The proxy inside MicroVM will return 502 until the worker reconnects.
// Reconnection is triggered lazily: the worker polls or is notified.
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 30_000; // 30s delay to allow suspend to settle

function scheduleReconnect(workerId: string) {
  if (!activePreview || activePreview.workerId !== workerId) return;

  let attempt = 0;

  const onPermanentFailure = async () => {
    if (!activePreview || activePreview.workerId !== workerId) return;
    console.error(`[preview] Reconnect permanently failed for ${workerId}. Full cleanup.`);
    clearInterval(activePreview.tokenRefreshTimer);
    activePreview.tunnelClient.close();
    const { microvmId } = activePreview;
    activePreview = null;
    try {
      await microvmsClient.send(new TerminateMicrovmCommand({ microvmIdentifier: microvmId }));
    } catch (e: any) {
      if (!e.name?.includes('NotFound')) {
        console.error(`[preview] Failed to terminate MicroVM ${microvmId}:`, e.message);
      }
    }
    try {
      await deletePreviewToken(workerId);
    } catch (e: any) {
      console.error(`[preview] Failed to delete preview token:`, e.message);
    }
    try {
      await writeMetadata(PREVIEW_METADATA_TAG, { previewUrl: null, localPort: null }, workerId);
      await notifyPreviewUpdate(workerId, null);
    } catch (e: any) {
      console.error(`[preview] Failed to clear metadata:`, e.message);
    }
  };

  const tryReconnect = () => {
    if (!activePreview || activePreview.workerId !== workerId) return;
    attempt++;

    if (attempt > MAX_RECONNECT_ATTEMPTS) {
      onPermanentFailure().catch((e) => console.error('[preview] Unexpected error in onPermanentFailure:', e));
      return;
    }

    // Use longer delay to avoid preventing idle suspend
    const delay = RECONNECT_DELAY_MS * attempt;
    console.log(`[preview] Reconnect attempt ${attempt} in ${delay}ms for ${workerId}`);

    setTimeout(async () => {
      if (!activePreview || activePreview.workerId !== workerId) return;

      try {
        const newTunnelToken = await createTunnelAuthToken(activePreview.microvmId);
        const tunnelClient = new TunnelClient(
          activePreview.microvmEndpoint,
          TUNNEL_PORT,
          activePreview.localPort,
          newTunnelToken,
          () => {
            console.log(`[preview] Tunnel disconnected again for ${workerId}`);
            scheduleReconnect(workerId);
          }
        );

        await tunnelClient.connect();
        activePreview.tunnelClient = tunnelClient;
        console.log(`[preview] Reconnected successfully for ${workerId}`);
      } catch (e: any) {
        console.error(`[preview] Reconnect attempt ${attempt} failed: ${e.message}`);
        tryReconnect();
      }
    }, delay);
  };

  tryReconnect();
}

// should-fix 6: Explicit initialization (no import side-effect), no process.exit forcing
let exitHandlersRegistered = false;
let cleanupInProgress = false;

export function registerPreviewExitHandlers(): void {
  if (exitHandlersRegistered) return;
  exitHandlersRegistered = true;

  const cleanup = async () => {
    if (cleanupInProgress) return;
    cleanupInProgress = true;
    if (activePreview) {
      console.log(`[preview] Process exiting, terminating preview for ${activePreview.workerId}`);
      try {
        await terminatePreview(activePreview.workerId);
      } catch (e: any) {
        console.error(`[preview] Cleanup on exit failed: ${e.message}`);
      }
    }
    cleanupInProgress = false;
  };

  const sigHandler = (sig: NodeJS.Signals) => {
    cleanup().finally(() => {
      process.removeListener('SIGTERM', sigHandler);
      process.removeListener('SIGINT', sigHandler);
      process.kill(process.pid, sig);
    });
  };
  process.on('SIGTERM', sigHandler);
  process.on('SIGINT', sigHandler);
  process.on('beforeExit', () => {
    cleanup();
  });
}

// --- closePreview ---

const closePreviewInputSchema = z.object({});

const closePreviewName = 'Close Preview';

export const terminatePreview = async (workerId: string): Promise<string> => {
  if (!activePreview) {
    // S3: Check DDB for orphaned state even if activePreview is null
    const existing = await getExistingPreviewState(workerId);
    if (existing) {
      await terminateOrphanedMicrovm(existing.microvmId);
      await deletePreviewToken(workerId);
      await writeMetadata(PREVIEW_METADATA_TAG, { previewUrl: null, localPort: null }, workerId);
      await notifyPreviewUpdate(workerId, null);
      return `Cleaned up orphaned preview. MicroVM ${existing.microvmId} terminated.`;
    }
    return 'No active preview session to close.';
  }

  const { microvmId, tunnelClient, tokenRefreshTimer } = activePreview;

  clearInterval(tokenRefreshTimer);
  tunnelClient.close();

  try {
    await microvmsClient.send(new TerminateMicrovmCommand({ microvmIdentifier: microvmId }));
  } catch (e: any) {
    console.error(`[preview] Failed to terminate MicroVM ${microvmId}:`, e.message);
  }

  try {
    await deletePreviewToken(workerId);
  } catch (e: any) {
    console.error(`[preview] Failed to delete preview token for ${workerId}:`, e.message);
  }

  try {
    await writeMetadata(PREVIEW_METADATA_TAG, { previewUrl: null, localPort: null }, workerId);
    await notifyPreviewUpdate(workerId, null);
  } catch (e: any) {
    console.error(`[preview] Failed to clear preview metadata for ${workerId}:`, e.message);
  }

  activePreview = null;

  return `Preview closed. MicroVM ${microvmId} terminated.`;
};

export const closePreviewTool: ToolDefinition<z.infer<typeof closePreviewInputSchema>> = {
  name: closePreviewName,
  handler: async (_input, context) => {
    try {
      return await terminatePreview(context.workerId);
    } catch (e: any) {
      return `Error in closePreview: ${e.name ?? 'Error'}: ${e.message}`;
    }
  },
  schema: closePreviewInputSchema,
  toolSpec: async () => ({
    name: closePreviewName,
    description: 'Close the active preview session by terminating the MicroVM tunnel and releasing all resources.',
    inputSchema: {
      json: zodToJsonSchemaBody(closePreviewInputSchema),
    },
  }),
};

import { SignatureV4 } from '@smithy/signature-v4';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { HttpRequest } from '@smithy/protocol-http';
import { Sha256 } from '@aws-crypto/sha256-js';
import z from 'zod';
import { webappEventSchema } from '../schema';

const httpEndpoint = process.env.EVENT_HTTP_ENDPOINT!;
const region = process.env.AWS_REGION!;

async function sendEvent(channelPath: string, payload: any) {
  if (!httpEndpoint) {
    // console.log(`event api is not configured!`);
    return;
  }

  const endpoint = `${httpEndpoint}/event`;
  const url = new URL(endpoint);

  // generate request
  const requestToBeSigned = new HttpRequest({
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      host: url.host,
    },
    hostname: url.host,
    body: JSON.stringify({
      channel: `event-bus/${channelPath}`,
      events: [JSON.stringify(payload)],
    }),
    path: url.pathname,
  });

  // initialize signer
  const signer = new SignatureV4({
    credentials: defaultProvider(),
    region,
    service: 'appsync',
    sha256: Sha256,
  });

  // sign request
  const signed = await signer.sign(requestToBeSigned);
  const request = new Request(endpoint, signed);

  // publish event via fetch
  const res = await fetch(request);

  const t = await res.text();
  console.log(t);
}

export const workerEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('onMessageReceived'),
  }),
  z.object({
    type: z.literal('forceStop'),
  }),
]);

export async function sendWorkerEvent(workerId: string, event: z.infer<typeof workerEventSchema>) {
  return sendEvent(`worker/${workerId}`, event);
}

// Omit does not work below because webappEventSchema is a union type.
type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;

export async function sendWebappEvent(
  workerId: string,
  event: DistributiveOmit<z.infer<typeof webappEventSchema>, 'timestamp' | 'workerId'>
) {
  try {
    await sendEvent(`webapp/worker/${workerId}`, {
      ...event,
      timestamp: Date.now(),
      workerId,
    } satisfies z.infer<typeof webappEventSchema>);
  } catch (e) {
    // webapp event is not critical so we do not throw on error.
    console.log(`failed to send event: ${e}`);
  }
}

import { SignatureV4 } from '@smithy/signature-v4';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { HttpRequest } from '@smithy/protocol-http';
import { Sha256 } from '@aws-crypto/sha256-js';
import z from 'zod';

const httpEndpoint = process.env.EVENT_HTTP_ENDPOINT!;
const region = process.env.AWS_REGION!;

async function sendEvent(channelPath: string, payload: any) {
  if (httpEndpoint == null) {
    console.log(`event api is not configured!`);
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
]);

export async function sendWorkerEvent(workerId: string, event: z.infer<typeof workerEventSchema>) {
  return sendEvent(`worker/${workerId}`, event);
}

export const webappEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('userMessage'),
    payload: z.object({
      message: z.string(),
      userId: z.string(),
      imageKeys: z.array(z.string()),
    }),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('toolUse'),
    payload: z.object({
      name: z.string(),
      input: z.string(),
    }),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('toolResult'),
    payload: z.object({
      name: z.string(),
    }),
    timestamp: z.number(),
  }),
]);

export async function sendWebappEvent(workerId: string, event: Omit<z.infer<typeof webappEventSchema>, 'timestamp'>) {
  try {
    await sendEvent(`webapp/worker/${workerId}`, {
      ...event,
      timestamp: Date.now(),
    });
  } catch (e) {
    // webapp event is not critical so we do not throw.
    console.log(`failed to send event: ${e}`);
  }
}

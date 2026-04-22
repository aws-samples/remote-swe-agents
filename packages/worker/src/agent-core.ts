// API implementation for agent core runtime
// https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-service-contract.html

import express from 'express';
import { main } from './entry';
import { updateInstanceStatus } from '@remote-swe-agents/agent-core/lib';

let getCurrentStatus: () => 'busy' | 'idle' | undefined;
const app = express();

app.use(express.json());

app.post('/invocations', async (req, res) => {
  const body = req.body;
  console.log(body);
  const sessionId = body.sessionId;

  // Store the agent runtime ARN passed from the invoker for later use (e.g. StopRuntimeSession)
  if (body.agentRuntimeArn) {
    process.env.AGENT_RUNTIME_ARN = body.agentRuntimeArn;
  }

  const tracker = await main(sessionId);
  if (tracker) {
    getCurrentStatus = () => (tracker.isBusy() ? 'busy' : 'idle');
  }

  // Always update instance status to 'running' on invocation,
  // even if the session was already started (e.g. after stop→resume)
  await updateInstanceStatus(sessionId, 'running');

  res.json({
    response: 'ok',
    status: 'success',
  });
});

app.get('/ping', (_req, res) => {
  const status = getCurrentStatus?.() ?? 'idle';
  res.json({
    status: status == 'idle' ? 'Healthy' : 'HealthyBusy',
    time_of_last_update: Math.floor(Date.now() / 1000),
  });
});

const port = 8080;
app.listen(port, () => {
  console.log(`Agent server listening on 0.0.0.0:${port}`);
});

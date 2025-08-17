// API implementation for agent core runtime
// https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-service-contract.html

import express from 'express';

let getCurrentStatus: () => 'busy' | 'idle' | undefined;
const app = express();

app.use(express.json());

app.post('/invocations', (req, res) => {
  const body = req.body;
  const sessionId = body.sessionId;
  

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

export const startAgentCoreRuntimeApi = async (getCurrentStatusHandler: () => 'busy' | 'idle') => {
  getCurrentStatus = getCurrentStatusHandler;
  const port = 8080;
  return new Promise<void>((resolve) => {
    app.listen(port, () => {
      console.log(`Agent server listening on 0.0.0.0:${port}`);
      resolve();
    });
  });
};

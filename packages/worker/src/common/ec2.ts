import { ec2 } from '@remote-swe-agents/agent-core/aws';
import { StopInstancesCommand, TerminateInstancesCommand } from '@aws-sdk/client-ec2';
import { BedrockAgentCoreClient, StopRuntimeSessionCommand } from '@aws-sdk/client-bedrock-agentcore';

const workerRuntime = process.env.WORKER_RUNTIME ?? 'ec2';
const agentRuntimeArn = process.env.AGENT_RUNTIME_ARN;

const agentCore = new BedrockAgentCoreClient();

export const stopMyself = async (workerId?: string) => {
  if (workerRuntime === 'agent-core') {
    if (!agentRuntimeArn || !workerId) {
      console.error('Cannot stop agent-core session: missing AGENT_RUNTIME_ARN or workerId');
      return;
    }
    try {
      await agentCore.send(
        new StopRuntimeSessionCommand({
          agentRuntimeArn,
          runtimeSessionId: workerId,
        })
      );
      console.log(`Stopped agent-core runtime session: ${workerId}`);
    } catch (error) {
      console.error('Error stopping agent-core runtime session:', error);
    }
    return;
  }

  const instanceId = await getInstanceId();
  await ec2.send(
    new StopInstancesCommand({
      InstanceIds: [instanceId],
    })
  );
};

export const terminateMyself = async () => {
  if (workerRuntime !== 'ec2') return;
  const instanceId = await getInstanceId();
  await ec2.send(
    new TerminateInstancesCommand({
      InstanceIds: [instanceId],
    })
  );
};

const getInstanceId = async () => {
  const token = await getImdsV2Token();
  const res = await fetch('http://169.254.169.254/latest/meta-data/instance-id', {
    headers: {
      'X-aws-ec2-metadata-token': token,
    },
  });
  return await res.text();
};

/**
 * Returns 'spot' for Spot instances, 'on-demand' otherwise.
 * Spot one-time instances cannot be stopped; use terminate instead.
 */
export const getInstanceLifecycle = async (): Promise<'spot' | 'on-demand'> => {
  if (workerRuntime !== 'ec2') return 'on-demand';
  const token = await getImdsV2Token();
  const res = await fetch('http://169.254.169.254/latest/meta-data/instance-life-cycle', {
    headers: {
      'X-aws-ec2-metadata-token': token,
    },
  });
  const value = (await res.text()).trim().toLowerCase();
  return value === 'spot' ? 'spot' : 'on-demand';
};

const getImdsV2Token = async () => {
  const res = await fetch('http://169.254.169.254/latest/api/token', {
    method: 'PUT',
    headers: {
      'X-aws-ec2-metadata-token-ttl-seconds': '900',
    },
  });
  return await res.text();
};

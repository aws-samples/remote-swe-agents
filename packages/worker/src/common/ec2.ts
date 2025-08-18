import { ec2 } from '@remote-swe-agents/agent-core/aws';
import { StopInstancesCommand } from '@aws-sdk/client-ec2';

const workerRuntime = process.env.WORKER_RUNTIME ?? 'ec2';

export const stopMyself = async () => {
  if (workerRuntime !== 'ec2') return;
  const instanceId = await getInstanceId();
  await ec2.send(
    new StopInstancesCommand({
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

const getImdsV2Token = async () => {
  const res = await fetch('http://169.254.169.254/latest/api/token', {
    method: 'PUT',
    headers: {
      'X-aws-ec2-metadata-token-ttl-seconds': '900',
    },
  });
  return await res.text();
};

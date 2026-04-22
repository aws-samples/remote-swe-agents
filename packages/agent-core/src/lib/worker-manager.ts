import {
  DescribeInstancesCommand,
  RunInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
} from '@aws-sdk/client-ec2';
import { GetParameterCommand, ParameterNotFound } from '@aws-sdk/client-ssm';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
  StopRuntimeSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { ec2, ssm } from './aws';
import { sendWebappEvent } from './events';
import { getSession, updateSession } from './sessions';
import { InstanceStatus, RuntimeType } from '../schema';

const agentCore = new BedrockAgentCoreClient();

const LaunchTemplateId = process.env.WORKER_LAUNCH_TEMPLATE_ID!;
const WorkerAmiParameterName = process.env.WORKER_AMI_PARAMETER_NAME ?? '';
const SubnetIdList = process.env.SUBNET_ID_LIST?.split(',') ?? [];

/**
 * Updates the instance status in DynamoDB and sends a webapp event
 */
export async function updateInstanceStatus(workerId: string, status: InstanceStatus) {
  try {
    // Update the instanceStatus using the generic updateSession function
    await updateSession(workerId, { instanceStatus: status });

    // Send event to webapp
    await sendWebappEvent(workerId, {
      type: 'instanceStatusChanged',
      status,
    });

    console.log(`Instance status updated to ${status}`);
  } catch (error) {
    console.error(`Error updating instance status for workerId ${workerId}:`, error);
  }
}

async function findStoppedWorkerInstance(workerId: string) {
  return findWorkerInstanceWithStatus(workerId, ['running', 'stopped']);
}

async function findRunningWorkerInstance(workerId: string) {
  return findWorkerInstanceWithStatus(workerId, ['running', 'pending']);
}

async function findWorkerInstanceWithStatus(workerId: string, statuses: string[]): Promise<string | null> {
  const describeCommand = new DescribeInstancesCommand({
    Filters: [
      {
        Name: 'tag:RemoteSweWorkerId',
        Values: [workerId],
      },
      {
        Name: 'instance-state-name',
        Values: statuses,
      },
    ],
  });

  try {
    const response = await ec2.send(describeCommand);

    if (response.Reservations && response.Reservations.length > 0) {
      const instances = response.Reservations[0].Instances;
      if (instances && instances.length > 0) {
        return instances[0].InstanceId || null;
      }
    }
    return null;
  } catch (error) {
    console.error(`Error finding worker instance with status ${statuses.join(',')}`, error);
    throw error;
  }
}

async function restartWorkerInstance(instanceId: string) {
  const startCommand = new StartInstancesCommand({
    InstanceIds: [instanceId],
  });

  try {
    await ec2.send(startCommand);
  } catch (error) {
    console.error('Error starting stopped instance:', error);
    throw error;
  }
}

async function fetchWorkerAmiId(workerAmiParameterName: string): Promise<string | undefined> {
  try {
    const result = await ssm.send(
      new GetParameterCommand({
        Name: workerAmiParameterName,
      })
    );
    return result.Parameter?.Value;
  } catch (e) {
    if (e instanceof ParameterNotFound) {
      return;
    }
    throw e;
  }
}

const useSpotInstances = process.env.WORKER_USE_SPOT === 'true';

function buildRunInstancesInput(
  workerId: string,
  launchTemplateId: string,
  imageId: string | undefined,
  subnetId: string,
  useSpot: boolean
): RunInstancesCommand['input'] {
  return {
    LaunchTemplate: {
      LaunchTemplateId: launchTemplateId,
      Version: '$Latest',
    },
    ImageId: imageId,
    MinCount: 1,
    MaxCount: 1,
    SubnetId: subnetId,
    // Remove UserData if launching from our AMI, where all the dependencies are already installed.
    UserData: imageId
      ? Buffer.from(
          `
#!/bin/bash
    `.trim()
        ).toString('base64')
      : undefined,
    TagSpecifications: [
      {
        ResourceType: 'instance',
        Tags: [
          {
            Key: 'RemoteSweWorkerId',
            Value: workerId,
          },
        ],
      },
    ],
    ...(useSpot && {
      InstanceMarketOptions: {
        MarketType: 'spot',
        SpotOptions: {
          SpotInstanceType: 'one-time',
        },
      },
    }),
  };
}

async function createWorkerInstance(
  workerId: string,
  launchTemplateId: string,
  workerAmiParameterName: string,
  subnetId: string
): Promise<{ instanceId: string; usedCache: boolean }> {
  const imageId = await fetchWorkerAmiId(workerAmiParameterName);

  const tryLaunch = async (useSpot: boolean) => {
    const input = buildRunInstancesInput(
      workerId,
      launchTemplateId,
      imageId,
      subnetId,
      useSpot
    );
    const response = await ec2.send(new RunInstancesCommand(input));
    if (response.Instances && response.Instances.length > 0 && response.Instances[0].InstanceId) {
      return response.Instances[0].InstanceId;
    }
    throw new Error('Failed to create EC2 instance');
  };

  try {
    const instanceId = await tryLaunch(useSpotInstances);
    return { instanceId, usedCache: !!imageId };
  } catch (error: unknown) {
    const err = error as { name?: string } | undefined;
    const isSpotCapacityError =
      useSpotInstances &&
      err &&
      typeof err === 'object' &&
      (err.name === 'InsufficientInstanceCapacity' ||
        err.name === 'InsufficientCapacity' ||
        err.name === 'CapacityNotAvailable');
    if (isSpotCapacityError) {
      console.warn('Spot capacity unavailable, retrying with On-Demand:', error);
      try {
        const instanceId = await tryLaunch(false);
        return { instanceId, usedCache: !!imageId };
      } catch (fallbackError) {
        console.error('Error creating worker instance (On-Demand fallback):', fallbackError);
        throw fallbackError;
      }
    }
    console.error('Error creating worker instance:', error);
    throw error;
  }
}

export async function getOrCreateWorkerInstance(
  workerId: string,
  workerType: 'agent-core' | 'ec2' = 'ec2'
): Promise<{ instanceId: string; oldStatus: 'stopped' | 'terminated' | 'running'; usedCache?: boolean }> {
  if (workerType == 'agent-core') {
    // Only set 'starting' if the session is not already running
    const session = await getSession(workerId);
    const currentInstanceStatus = session?.instanceStatus;
    if (currentInstanceStatus !== 'running') {
      await updateInstanceStatus(workerId, 'starting');
    }
    const agentRuntimeArn = process.env.AGENT_RUNTIME_ARN!;
    const res = await agentCore.send(
      new InvokeAgentRuntimeCommand({
        agentRuntimeArn,
        runtimeSessionId: workerId,
        payload: JSON.stringify({ sessionId: workerId, agentRuntimeArn }),
        contentType: 'application/json',
      })
    );
    // Update to 'running' after successful invocation
    // (also done in the container, but doing it here ensures it works
    // even with older container images)
    await updateInstanceStatus(workerId, 'running');
    return { instanceId: 'local', oldStatus: currentInstanceStatus === 'running' ? 'running' : 'stopped' };
  }

  // First, check if an instance with this workerId is already running
  const runningInstanceId = await findRunningWorkerInstance(workerId);
  if (runningInstanceId) {
    return { instanceId: runningInstanceId, oldStatus: 'running' };
  }

  // Then, check if a stopped instance exists and start it
  const stoppedInstanceId = await findStoppedWorkerInstance(workerId);
  if (stoppedInstanceId) {
    await updateInstanceStatus(workerId, 'starting');
    await restartWorkerInstance(stoppedInstanceId);
    return { instanceId: stoppedInstanceId, oldStatus: 'stopped' };
  }

  // choose subnet randomly
  const subnetId = SubnetIdList[Math.floor(Math.random() * SubnetIdList.length)];
  // If no instance exists, create a new one
  await updateInstanceStatus(workerId, 'starting');
  const { instanceId, usedCache } = await createWorkerInstance(
    workerId,
    LaunchTemplateId,
    WorkerAmiParameterName,
    subnetId
  );
  return { instanceId, oldStatus: 'terminated', usedCache };
}

/**
 * Stop a worker instance (EC2 or agent-core runtime session)
 * @param workerId Worker ID of the session to stop
 * @param runtimeType The runtime type ('ec2' or 'agent-core')
 */
export async function stopWorkerInstance(workerId: string, runtimeType: RuntimeType = 'ec2'): Promise<void> {
  if (runtimeType === 'agent-core') {
    const agentRuntimeArn = process.env.AGENT_RUNTIME_ARN;
    if (!agentRuntimeArn) {
      console.error('Cannot stop agent-core session: missing AGENT_RUNTIME_ARN');
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
  } else {
    const instanceId = await findWorkerInstanceWithStatus(workerId, ['running', 'pending']);
    if (instanceId) {
      try {
        await ec2.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
        console.log(`Stopped EC2 instance: ${instanceId}`);
      } catch (error) {
        console.error('Error stopping EC2 instance:', error);
      }
    }
  }
  await updateInstanceStatus(workerId, 'stopped');
}

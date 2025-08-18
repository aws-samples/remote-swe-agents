import { DescribeInstancesCommand, RunInstancesCommand, StartInstancesCommand } from '@aws-sdk/client-ec2';
import { GetParameterCommand, ParameterNotFound } from '@aws-sdk/client-ssm';
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, ec2, ssm, TableName } from './aws';
import { sendWebappEvent } from './events';

const agentCore = new BedrockAgentCoreClient({ region: 'us-east-1' });

const LaunchTemplateId = process.env.WORKER_LAUNCH_TEMPLATE_ID!;
const WorkerAmiParameterName = process.env.WORKER_AMI_PARAMETER_NAME ?? '';
const SubnetIdList = process.env.SUBNET_ID_LIST?.split(',') ?? [];

/**
 * Updates the instance status in DynamoDB and sends a webapp event
 */
export async function updateInstanceStatus(workerId: string, status: 'starting' | 'running' | 'stopped') {
  try {
    // Update the instanceStatus in DynamoDB
    await ddb.send(
      new UpdateCommand({
        TableName,
        Key: {
          PK: 'sessions',
          SK: workerId,
        },
        UpdateExpression: 'SET instanceStatus = :status',
        ExpressionAttributeValues: {
          ':status': status,
        },
      })
    );

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

async function createWorkerInstance(
  workerId: string,
  launchTemplateId: string,
  workerAmiParameterName: string,
  subnetId: string
): Promise<{ instanceId: string; usedCache: boolean }> {
  const imageId = await fetchWorkerAmiId(workerAmiParameterName);

  const runInstancesCommand = new RunInstancesCommand({
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
  });

  try {
    const response = await ec2.send(runInstancesCommand);
    if (response.Instances && response.Instances.length > 0 && response.Instances[0].InstanceId) {
      return { instanceId: response.Instances[0].InstanceId, usedCache: !!imageId };
    }
    throw new Error('Failed to create EC2 instance');
  } catch (error) {
    console.error('Error creating worker instance:', error);
    throw error;
  }
}

export async function getOrCreateWorkerInstance(
  workerId: string,
  workerType: 'agentCore' | 'ec2' = 'ec2'
): Promise<{ instanceId: string; oldStatus: 'stopped' | 'terminated' | 'running'; usedCache?: boolean }> {
  if (workerType == 'agentCore') {
    console.log(workerId);
    const res = await agentCore.send(
      new InvokeAgentRuntimeCommand({
        agentRuntimeArn: process.env.AGENT_RUNTIME_ARN,
        runtimeSessionId: workerId,
        payload: JSON.stringify({ sessionId: workerId }),
        contentType: 'application/json',
      })
    );
    console.log(res);
    return { instanceId: 'local', oldStatus: 'running' };
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

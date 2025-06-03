import { EC2Client, DescribeInstancesCommand, RunInstancesCommand, StartInstancesCommand } from '@aws-sdk/client-ec2';
import { GetParameterCommand, ParameterNotFound, SSMClient } from '@aws-sdk/client-ssm';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TableName } from './aws';
import { sendWebappEvent } from './events';

const LaunchTemplateId = process.env.WORKER_LAUNCH_TEMPLATE_ID!;
const WorkerAmiParameterName = process.env.WORKER_AMI_PARAMETER_NAME ?? '';
const SubnetIdList = process.env.SUBNET_ID_LIST?.split(',') ?? [];
const ec2Client = new EC2Client({});
const ssmClient = new SSMClient({});

/**
 * Updates the instance status in DynamoDB and sends a webapp event
 */
export async function updateInstanceStatus(workerId: string, status: 'starting' | 'running' | 'sleeping') {
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
    const response = await ec2Client.send(describeCommand);

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
    await ec2Client.send(startCommand);
  } catch (error) {
    console.error('Error starting stopped instance:', error);
    throw error;
  }
}

async function fetchWorkerAmiId(workerAmiParameterName: string): Promise<string | undefined> {
  try {
    const result = await ssmClient.send(
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
  slackChannelId: string,
  slackThreadTs: string,
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
          {
            Key: 'SlackChannelId',
            Value: slackChannelId,
          },
          {
            Key: 'SlackThreadTs',
            Value: slackThreadTs,
          },
        ],
      },
    ],
  });

  try {
    const response = await ec2Client.send(runInstancesCommand);
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
  slackChannelId: string,
  slackThreadTs: string
): Promise<{ instanceId: string; oldStatus: 'stopped' | 'terminated' | 'running'; usedCache?: boolean }> {
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
    slackChannelId,
    slackThreadTs,
    LaunchTemplateId,
    WorkerAmiParameterName,
    subnetId
  );
  return { instanceId, oldStatus: 'terminated', usedCache };
}

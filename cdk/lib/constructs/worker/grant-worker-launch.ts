import { IGrantable, IRole, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { IStringParameter } from 'aws-cdk-lib/aws-ssm';

export interface WorkerLaunchCapabilityProps {
  /**
   * The identity that needs to launch EC2 worker instances.
   */
  grantee: IGrantable;
  /**
   * SSM parameter that stores the worker AMI id.
   */
  amiIdParameter: IStringParameter;
  /**
   * Launch template id used to start worker EC2 instances.
   */
  launchTemplateId: string;
  /**
   * Comma separated list of subnet ids in which workers are launched.
   */
  subnetIdListForWorkers: string;
  /**
   * The IAM role attached to worker EC2 instances. Required to scope iam:PassRole.
   */
  workerInstanceRole: IRole;
}

/**
 * Grants a principal everything it needs to launch EC2 worker instances and
 * returns the environment variables consumed by `packages/agent-core` and
 * `packages/worker` at runtime.
 *
 * Keeping the IAM wiring and env var wiring in a single place prevents the
 * two halves from drifting apart — a previous bug was caused by an env var
 * defaulting to an empty string which in turn caused
 * `ssm:GetParameter({Name: ''})` to fail with a ValidationException.
 */
export function grantWorkerLaunchCapability(props: WorkerLaunchCapabilityProps): {
  WORKER_AMI_PARAMETER_NAME: string;
  WORKER_LAUNCH_TEMPLATE_ID: string;
  SUBNET_ID_LIST: string;
} {
  const { grantee, amiIdParameter, launchTemplateId, subnetIdListForWorkers, workerInstanceRole } = props;

  // Read the worker AMI id from SSM (resource scoped).
  amiIdParameter.grantRead(grantee);

  // ec2:* actions required to launch and manage worker instances.
  // These APIs do not support resource-level permissions for all of the
  // required actions (e.g. ec2:DescribeInstances), so we keep the resource
  // wildcard for the ec2 block.
  grantee.grantPrincipal.addToPrincipalPolicy(
    new PolicyStatement({
      actions: [
        'ec2:RunInstances',
        'ec2:DescribeInstances',
        'ec2:StartInstances',
        'ec2:StopInstances',
        'ec2:CreateTags',
      ],
      resources: ['*'],
    })
  );

  // iam:PassRole must be scoped to the exact worker instance role to avoid
  // allowing the principal to pass arbitrary roles to EC2.
  grantee.grantPrincipal.addToPrincipalPolicy(
    new PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [workerInstanceRole.roleArn],
    })
  );

  return {
    WORKER_AMI_PARAMETER_NAME: amiIdParameter.parameterName,
    WORKER_LAUNCH_TEMPLATE_ID: launchTemplateId,
    SUBNET_ID_LIST: subnetIdListForWorkers,
  };
}

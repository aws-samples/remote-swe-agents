import { Construct } from 'constructs';
import { Arn, ArnFormat, CustomResource, Duration, Stack } from 'aws-cdk-lib';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Runtime, Code, SingletonFunction } from 'aws-cdk-lib/aws-lambda';
import { Provider } from 'aws-cdk-lib/custom-resources';

/**
 * Cleans up SSM Parameters created at runtime under `/${stackName}/users/` on stack deletion.
 *
 * The webapp Lambda creates per-user SSM Parameters (e.g. Kiro API keys) at runtime via
 * `ssm:PutParameter`. These parameters are not managed by CloudFormation, so they are left
 * behind after `cdk destroy`, polluting the SSM namespace. This construct installs a
 * Custom Resource whose `onDelete` hook sweeps those parameters.
 *
 * Create/Update events are no-ops. The cleanup is best-effort: failures are logged but
 * never block the stack deletion.
 */
export class UserParamsCleaner extends Construct {
  public readonly customResource: CustomResource;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    const stackName = Stack.of(this).stackName;
    const pathPrefix = `/${stackName}/users/`;

    const userParamsArn = Arn.format(
      {
        service: 'ssm',
        resource: 'parameter',
        resourceName: `${stackName}/users/*`,
        arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
      },
      Stack.of(this)
    );

    const handler = new SingletonFunction(this, 'Handler', {
      uuid: 'user-params-cleaner-singleton',
      runtime: Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: Code.fromInline(`
const { SSMClient, GetParametersByPathCommand, DeleteParametersCommand } = require('@aws-sdk/client-ssm');

exports.handler = async (event) => {
  const physicalResourceId = event.PhysicalResourceId || 'user-params-cleaner';

  // Create and Update are no-ops. Cleanup runs only on stack deletion.
  if (event.RequestType !== 'Delete') {
    return { PhysicalResourceId: physicalResourceId };
  }

  const pathPrefix = event.ResourceProperties.PathPrefix;
  const ssm = new SSMClient({});

  console.log('Starting cleanup under path: ' + pathPrefix);

  const names = [];
  let nextToken;
  try {
    do {
      const resp = await ssm.send(new GetParametersByPathCommand({
        Path: pathPrefix,
        Recursive: true,
        MaxResults: 10,
        NextToken: nextToken,
      }));
      for (const p of resp.Parameters || []) {
        if (p.Name) names.push(p.Name);
      }
      nextToken = resp.NextToken;
    } while (nextToken);
  } catch (err) {
    // Best-effort cleanup: never block stack deletion.
    console.error('Failed to list parameters. Skipping cleanup.', err);
    return { PhysicalResourceId: physicalResourceId };
  }

  console.log('Found ' + names.length + ' parameter(s) to delete');

  // DeleteParameters accepts at most 10 names per request.
  for (let i = 0; i < names.length; i += 10) {
    const batch = names.slice(i, i + 10);
    try {
      const resp = await ssm.send(new DeleteParametersCommand({ Names: batch }));
      if (resp.DeletedParameters && resp.DeletedParameters.length > 0) {
        console.log('Deleted: ' + resp.DeletedParameters.join(', '));
      }
      if (resp.InvalidParameters && resp.InvalidParameters.length > 0) {
        // Already gone or inaccessible. Treated as expected.
        console.warn('Skipped (not found or invalid): ' + resp.InvalidParameters.join(', '));
      }
    } catch (err) {
      // Continue with remaining batches even if one fails.
      console.error('Failed to delete batch: ' + batch.join(', '), err);
    }
  }

  return { PhysicalResourceId: physicalResourceId };
};
      `),
      timeout: Duration.minutes(5),
    });

    handler.addToRolePolicy(
      new PolicyStatement({
        actions: ['ssm:GetParametersByPath', 'ssm:DeleteParameters'],
        resources: [userParamsArn],
      })
    );

    const provider = new Provider(this, 'Provider', {
      onEventHandler: handler,
    });

    this.customResource = new CustomResource(this, 'Resource', {
      serviceToken: provider.serviceToken,
      properties: {
        PathPrefix: pathPrefix,
      },
    });
  }
}

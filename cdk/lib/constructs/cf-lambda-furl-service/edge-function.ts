import { Stack } from 'aws-cdk-lib';
import { PolicyStatement, ServicePrincipal, Role } from 'aws-cdk-lib/aws-iam';
import { Runtime, IVersion, Version, Architecture } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { AwsCustomResource, PhysicalResourceId, AwsCustomResourcePolicy } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

// L@E can only be deployed to us-east-1 region.
const StackRegion = 'us-east-1';

export interface EdgeFunctionProps {
  entryPath: string;
}

export class EdgeFunction extends Construct {
  private readonly functionVersionParameter: StringParameter;

  constructor(scope: Construct, id: string, props: EdgeFunctionProps) {
    super(scope, id);

    if (Stack.of(this).region !== StackRegion) {
      throw new Error('EdgeFunction can only be deployed to us-east-1 region.');
    }

    const handler = new NodejsFunction(this, 'Handler', {
      runtime: Runtime.NODEJS_22_X,
      entry: props.entryPath,
    });
    handler.currentVersion;
    this.functionVersionParameter = new StringParameter(this, 'FunctionVersion', {
      stringValue: handler.currentVersion.edgeArn,
    });

    const statement = new PolicyStatement();
    const edgeLambdaServicePrincipal = new ServicePrincipal('edgelambda.amazonaws.com');
    statement.addPrincipals(edgeLambdaServicePrincipal);
    statement.addActions(edgeLambdaServicePrincipal.assumeRoleAction);
    (handler.role as Role).assumeRolePolicy!.addStatements(statement);
  }

  public versionArn(scope: Construct) {
    const id = `VersionArn${this.functionVersionParameter.node.addr}`;
    const existing = Stack.of(scope).node.tryFindChild(id) as IVersion;
    if (existing) {
      return existing;
    }

    const lookup = new AwsCustomResource(Stack.of(scope), `Lookup${id}`, {
      onUpdate: {
        // will also be called for a CREATE event
        service: 'SSM',
        action: 'getParameter',
        parameters: {
          Name: this.functionVersionParameter.parameterName,
        },
        // it is impossible to know when the parameter is updated.
        // so we need to get the value on every deployment.
        physicalResourceId: PhysicalResourceId.of(`${Date.now()}`),
        region: StackRegion,
      },
      policy: AwsCustomResourcePolicy.fromSdkCalls({
        resources: [this.functionVersionParameter.parameterArn],
      }),
    });
    return Version.fromVersionArn(Stack.of(scope), id, lookup.getResponseField('Parameter.Value'));
  }
}

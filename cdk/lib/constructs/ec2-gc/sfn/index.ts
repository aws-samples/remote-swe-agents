import * as cdk from 'aws-cdk-lib';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as fs from 'fs';
import * as path from 'path';
import { Construct } from 'constructs';
import { IStringParameter } from 'aws-cdk-lib/aws-ssm';

export interface EC2GarbageCollectorStepFunctionsProps {
  imageRecipeName: string;
  expirationInDays: number;
  workerAmiIdParameter: IStringParameter;
}

export class EC2GarbageCollectorStepFunctions extends Construct {
  public readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: EC2GarbageCollectorStepFunctionsProps) {
    super(scope, id);

    const aslPath = path.join(__dirname, 'asl.json');

    // Create state machine (using definitionSubstitutions to replace placeholders)
    this.stateMachine = new sfn.StateMachine(this, 'Resource', {
      definitionBody: sfn.DefinitionBody.fromString(fs.readFileSync(aslPath, 'utf8')),
      definitionSubstitutions: {
        expirationInDays: props.expirationInDays.toString(),
        imageRecipeNamePattern: `${props.imageRecipeName}*`,
        workerAmiIdParameterName: props.workerAmiIdParameter.parameterName,
      },
      timeout: cdk.Duration.seconds(600),
    });

    this.stateMachine.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'ec2:DescribeInstances',
          'ec2:TerminateInstances',
          'ec2:DescribeImages',
          'ec2:DeregisterImage',
          'ec2:DeleteSnapshot',
        ],
        resources: ['*'],
      })
    );
    props.workerAmiIdParameter.grantRead(this.stateMachine);
    this.stateMachine.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['imagebuilder:DeleteImage'],
        resources: ['*'],
      })
    );
  }
}

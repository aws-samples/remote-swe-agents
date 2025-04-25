import * as cdk from 'aws-cdk-lib';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as fs from 'fs';
import * as path from 'path';
import { Construct } from 'constructs';

export interface EC2GarbageCollectorStepFunctionsProps {
  imageRecipeName: string;
  expirationInDays: number;
}

export class EC2GarbageCollectorStepFunctions extends Construct {
  public readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: EC2GarbageCollectorStepFunctionsProps) {
    super(scope, id);

    // Set the appropriate calculation formula based on expirationInDays
    let expirationFormula: string;
    expirationFormula = `{% $millis() - 1000 * 60 * 60 * 24 * ${props.expirationInDays} %}`;

    // Path to ASL file
    const aslPath = path.join(__dirname, 'asl.json');

    // Create state machine (using definitionSubstitutions to replace placeholders)
    this.stateMachine = new sfn.StateMachine(this, 'Resource', {
      definitionBody: sfn.DefinitionBody.fromString(fs.readFileSync(aslPath, 'utf8')),
      definitionSubstitutions: {
        // expirationThreshold: expirationFormula,
        expirationInDays: props.expirationInDays.toString(),
        imageRecipeNamePattern: props.imageRecipeName,
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
    this.stateMachine.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: ['arn:aws:ssm:*:*:parameter/remote-swe/worker/ami-id'],
      })
    );
    this.stateMachine.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['imagebuilder:DeleteImage'],
        resources: ['*'],
      })
    );
  }
}

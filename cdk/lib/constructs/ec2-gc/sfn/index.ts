import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as fs from 'fs';
import * as path from 'path';
import { Construct } from 'constructs';

export interface EC2GarbageCollectorStepFunctionsProps {
  imageRecipeName?: string;
  expirationInDays: number;
}

export class EC2GarbageCollectorStepFunctions extends Construct {
  constructor(scope: Construct, id: string, props: EC2GarbageCollectorStepFunctionsProps) {
    super(scope, id);
    
    // Set the appropriate calculation formula based on expirationInDays
    let expirationFormula: string;
    expirationFormula = `{% $millis() - 1000 * 60 * 60 * 24 * ${props.expirationInDays} %}`;

    // Set up necessary IAM permissions
    const stateMachineRole = new iam.Role(this, 'StepFunctionsRole', {
      assumedBy: new iam.ServicePrincipal('states.amazonaws.com'),
      description: 'Role for EC2GarbageCollector Step Functions',
    });
    
    // EC2 instance-related permissions
    stateMachineRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ec2:DescribeInstances',
        'ec2:TerminateInstances',
        'ec2:DescribeImages',
        'ec2:DeregisterImage',
        'ec2:DeleteSnapshot',
      ],
      resources: ['*'],
    }));
    
    // SSM Parameter Store-related permissions
    stateMachineRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ssm:GetParameter',
      ],
      resources: ['arn:aws:ssm:*:*:parameter/remote-swe/worker/ami-id'],
    }));
    
    // ImageBuilder-related permissions
    stateMachineRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'imagebuilder:DeleteImage',
      ],
      resources: ['*'],
    }));

    // Path to ASL file
    const aslPath = path.join(__dirname, 'asl.json');
    
    // Create state machine (using definitionSubstitutions to replace placeholders)
    const stateMachine = new sfn.StateMachine(this, 'EC2GarbageCollector', {
      definitionBody: sfn.DefinitionBody.fromString(fs.readFileSync(aslPath, 'utf8')),
      definitionSubstitutions: {
        expirationThreshold: expirationFormula,
        imageRecipeNamePattern: props.imageRecipeName ? `${props.imageRecipeName}*` : 'RemoteSweStackSandboxWorkerImageBuilderImagePipelineV26F9C4AFCB6F87B*'
      },
      timeout: cdk.Duration.seconds(600),
      role: stateMachineRole,
    });

    const schedule = new events.Rule(this, 'ScheduleForEC2GarbageCollector', {
      schedule: events.Schedule.rate(cdk.Duration.hours(2)),
    });

    schedule.addTarget(new targets.SfnStateMachine(stateMachine));
  }
}

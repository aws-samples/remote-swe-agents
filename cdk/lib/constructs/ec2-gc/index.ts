import { Construct } from 'constructs';
import { Duration } from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { EC2GarbageCollectorStepFunctions } from './sfn';

export interface EC2GarbageCollectorProps {
  imageRecipeName: string;
  expirationInDays: number;
}

export class EC2GarbageCollector extends Construct {
  constructor(scope: Construct, id: string, props: EC2GarbageCollectorProps) {
    super(scope, id);

    // EC2 garbage collection implementation using Step Functions and JSONata
    const eC2GarbageCollectorStepFunctions = new EC2GarbageCollectorStepFunctions(this, 'StateMachine', {
      imageRecipeName: props.imageRecipeName,
      expirationInDays: props.expirationInDays,
    });

    const schedule = new events.Rule(this, 'Schedule', {
      schedule: events.Schedule.rate(Duration.hours(2)),
    });
    schedule.addTarget(new targets.SfnStateMachine(eC2GarbageCollectorStepFunctions.stateMachine));
  }
}

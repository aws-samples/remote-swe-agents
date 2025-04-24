import { Construct } from 'constructs';
import { EC2GarbageCollectorStepFunctions } from './sfn';

export interface EC2GarbageCollectorProps {
  imageRecipeName?: string;
  expirationInDays: number;
}

export class EC2GarbageCollector extends Construct {
  constructor(scope: Construct, id: string, props: EC2GarbageCollectorProps) {
    super(scope, id);

    // EC2 garbage collection implementation using Step Functions and JSONata
    new EC2GarbageCollectorStepFunctions(this, 'StepFunctions', {
      imageRecipeName: props?.imageRecipeName,
      expirationInDays: props.expirationInDays,
    });
  }
}

import { Construct } from 'constructs';
import { EC2GarbageCollectorStepFunctions } from './step-functions';

export interface EC2GarbageCollectorProps {
  imageRecipeName?: string;
  expirationInDays?: number;
}

export class EC2GarbageCollector extends Construct {
  constructor(scope: Construct, id: string, props?: EC2GarbageCollectorProps) {
    super(scope, id);

    // Step FunctionsとJSONataを使用したEC2ガベージコレクション実装
    new EC2GarbageCollectorStepFunctions(this, 'StepFunctions', {
      imageRecipeName: props?.imageRecipeName,
      expirationInDays: props?.expirationInDays || 1,
    });
  }
}

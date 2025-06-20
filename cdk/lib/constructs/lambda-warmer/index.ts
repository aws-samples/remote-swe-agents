import { Construct } from 'constructs';
import { LambdaInvoke } from 'aws-cdk-lib/aws-scheduler-targets';
import { Schedule, ScheduleExpression, ScheduleTargetInput } from 'aws-cdk-lib/aws-scheduler';
import { Duration } from 'aws-cdk-lib';
import { Function, Runtime } from 'aws-cdk-lib/aws-lambda';
import { LambdaWarmerPayload } from './lambda/type';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { join } from 'path';

export interface LambdaWarmerProps {}

export class LambdaWarmer extends Construct {
  private handler: Function;

  constructor(scope: Construct, id: string, props: LambdaWarmerProps) {
    super(scope, id);

    const handler = new NodejsFunction(this, 'Handler', {
      entry: join(__dirname, 'lambda', 'handler.ts'),
      runtime: Runtime.NODEJS_22_X,
      timeout: Duration.seconds(10),
    });

    this.handler = handler;
  }

  addTarget(id: string, url: string, concurrency: number) {
    const target = new LambdaInvoke(this.handler, {
      maxEventAge: Duration.minutes(1),
      retryAttempts: 0,
      input: ScheduleTargetInput.fromObject({
        url,
        concurrency,
      } satisfies LambdaWarmerPayload),
    });

    new Schedule(this, `${id}Schedule`, {
      schedule: ScheduleExpression.rate(Duration.minutes(4)),
      target,
    });
  }
}

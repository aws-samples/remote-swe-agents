import { Construct } from 'constructs';
import { CfnOutput, Duration, TimeZone } from 'aws-cdk-lib';
import { Architecture, DockerImageCode, DockerImageFunction, IFunction } from 'aws-cdk-lib/aws-lambda';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { EventBus } from './event-bus';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { join } from 'path';
import { Schedule, ScheduleExpression, ScheduleTargetInput } from 'aws-cdk-lib/aws-scheduler';
import { LambdaInvoke } from 'aws-cdk-lib/aws-scheduler-targets';
import { Storage } from './storage';
import { readFileSync } from 'fs';

export interface AsyncJobProps {
  readonly storage: Storage;
  readonly eventBus: EventBus;
}

export class AsyncJob extends Construct {
  readonly handler: IFunction;

  constructor(scope: Construct, id: string, props: AsyncJobProps) {
    super(scope, id);
    const { storage, eventBus } = props;

    const handler = new DockerImageFunction(this, 'Handler', {
      code: DockerImageCode.fromImageAsset('..', {
        file: join('docker', 'job.Dockerfile'),
        exclude: readFileSync(join('..', 'docker', 'job.Dockerfile.dockerignore'))
          .toString()
          .split('\n'),
        cmd: ['async-handler.handler'],
        platform: Platform.LINUX_AMD64,
      }),
      memorySize: 256,
      timeout: Duration.minutes(10),
      architecture: Architecture.ARM_64,
      environment: {
        TABLE_NAME: storage.table.tableName,
        EVENT_HTTP_ENDPOINT: eventBus.httpEndpoint,
      },
      // limit concurrency to mitigate any possible EDoS attacks
      reservedConcurrentExecutions: 1,
    });

    eventBus.api.grantPublish(handler);
    storage.table.grantReadWriteData(handler);

    handler.addToRolePolicy(
      new PolicyStatement({
        actions: ['translate:TranslateText', 'comprehend:DetectDominantLanguage'],
        resources: ['*'],
      })
    );

    new CfnOutput(this, 'HandlerArn', { value: handler.functionArn });
    this.handler = handler;

    // you can add scheduled jobs here.
    this.addSchedule(
      'SampleJob',
      ScheduleExpression.cron({ minute: '0', hour: '0', day: '1', timeZone: TimeZone.ETC_UTC })
    );
  }

  public addSchedule(jobType: string, schedule: ScheduleExpression, payload?: any) {
    return new Schedule(this, jobType, {
      schedule,
      target: new LambdaInvoke(this.handler, {
        input: ScheduleTargetInput.fromObject({ jobType, payload }),
        retryAttempts: 5,
      }),
    });
  }
}

import { JobPayloadProps } from '@/jobs/async-job-runner';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';

const lambda = new LambdaClient();

const handlerArn = process.env.ASYNC_JOB_HANDLER_ARN!;

export async function runJob(props: JobPayloadProps) {
  await lambda.send(
    new InvokeCommand({
      FunctionName: handlerArn,
      InvocationType: 'Event',
      Payload: JSON.stringify(props),
    })
  );
}

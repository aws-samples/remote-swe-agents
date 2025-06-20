import { Handler } from 'aws-lambda';
import { LambdaWarmerPayload } from './type';

export const handler: Handler<LambdaWarmerPayload> = async (event, context) => {
  const { url, concurrency } = event;

  console.log(`warming ${url} with concurrency ${concurrency}...`);

  await Promise.all(
    new Array(concurrency).fill(0).map(async () => {
      await fetch(url);
    })
  );
};

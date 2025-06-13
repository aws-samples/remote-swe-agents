import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

if (process.env.APP_ORIGIN_SOURCE_PARAMETER && !process.env.APP_ORIGIN) {
  const ssm = new SSMClient({ region: process.env.AWS_REGION });
  try {
    const res = await ssm.send(new GetParameterCommand({ Name: process.env.APP_ORIGIN_SOURCE_PARAMETER }));
    process.env.APP_ORIGIN = res.Parameter?.Value;
  } catch (e) {
    console.log(e);
  }
}

export const AppOrigin = process.env.APP_ORIGIN;

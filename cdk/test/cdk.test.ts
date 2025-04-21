import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { readFileSync } from 'fs';
import { MainStack } from '../lib/cdk-stack';

test('Snapshot test', () => {
  jest.useFakeTimers().setSystemTime(new Date('2020-01-01'));

  const app = new cdk.App({
    context: {
      ...JSON.parse(readFileSync('cdk.json').toString()).context,
    },
  });

  const main = new MainStack(app, `TestMainStack`, {
    env: {
      account: '123456789012',
      region: 'us-east-1',
    },
    slack: {
      botTokenParameterName: '/remote-swe/slack/bot-token',
      signingSecretParameterName: '/remote-swe/slack/signing-secret',
      adminUserIdList: undefined,
    },
    github: {
      privateKeyParameterName: '/remote-swe/github/app-private-key',
      appId: '123456',
      installationId: '9876543',
    },
    workerAmiIdParameterName: '/remote-swe/worker/ami-id',
  });

  expect(Template.fromStack(main)).toMatchSnapshot();
});

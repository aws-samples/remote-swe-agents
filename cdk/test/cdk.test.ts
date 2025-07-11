import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { readFileSync } from 'fs';
import { MainStack } from '../lib/cdk-stack';
import { UsEast1Stack } from '../lib/us-east-1-stack';

test('Snapshot test', () => {
  jest.useFakeTimers().setSystemTime(new Date('2020-01-01'));

  const app = new cdk.App({
    context: {
      ...JSON.parse(readFileSync('cdk.json').toString()).context,
    },
  });

  // Create the UsEast1Stack first
  const usEast1Stack = new UsEast1Stack(app, 'TestUsEast1Stack', {
    env: {
      account: '123456789012',
      region: 'us-east-1',
    },
    crossRegionReferences: true,
    // Add WAF IP restriction settings for testing
    allowedIpV4AddressRanges: ['192.168.1.0/24', '10.0.0.0/8'],
    allowedIpV6AddressRanges: ['2001:db8::/32'],
    allowedCountryCodes: ['JP', 'US'],
  });

  // Create the main stack with signPayloadHandler from UsEast1Stack
  const main = new MainStack(app, `TestMainStack`, {
    env: {
      account: '123456789012',
      region: 'us-east-1',
    },
    crossRegionReferences: true,
    signPayloadHandler: usEast1Stack.signPayloadHandler,
    cloudFrontWebAclArn: usEast1Stack.webAclArn,
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
    additionalManagedPolicies: [
      'AmazonS3ReadOnlyAccess',
      'AmazonDynamoDBReadOnlyAccess',
      'arn:aws:iam::aws:policy/AmazonECR-FullAccess',
      'arn:aws:iam::123456789012:policy/CustomPolicy',
    ],
    initialWebappUserEmail: 'user@example.com',
  });

  // Test both stacks
  expect(Template.fromStack(usEast1Stack)).toMatchSnapshot('UsEast1Stack');
  expect(Template.fromStack(main)).toMatchSnapshot('MainStack');
});

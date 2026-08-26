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
    additionalManagedPolicies: [
      'AmazonS3ReadOnlyAccess',
      'AmazonDynamoDBReadOnlyAccess',
      'arn:aws:iam::aws:policy/AmazonECR-FullAccess',
      'arn:aws:iam::123456789012:policy/CustomPolicy',
    ],
    initialWebappUserEmail: 'user@example.com',
    bedrockCriRegionOverride: 'global',
  });

  // Test both stacks
  expect(Template.fromStack(usEast1Stack)).toMatchSnapshot('UsEast1Stack');
  expect(Template.fromStack(main)).toMatchSnapshot('MainStack');
});

test('Kiro CLI inference mode wiring (opt-in)', () => {
  jest.useFakeTimers().setSystemTime(new Date('2020-01-01'));

  const app = new cdk.App({
    context: {
      ...JSON.parse(readFileSync('cdk.json').toString()).context,
    },
  });

  const usEast1Stack = new UsEast1Stack(app, 'TestUsEast1StackKiro', {
    env: { account: '123456789012', region: 'us-east-1' },
    crossRegionReferences: true,
  });

  const main = new MainStack(app, 'TestMainStackKiro', {
    env: { account: '123456789012', region: 'us-east-1' },
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
    kiroApiKeyParameterName: '/remote-swe/kiro/api-key',
    inferenceMode: 'kiro-cli',
  });

  const template = Template.fromStack(main);

  // The AgentCore runtime receives the Kiro env vars
  template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
    EnvironmentVariables: {
      KIRO_API_KEY_SSM_PARAM: '/remote-swe/kiro/api-key',
      INFERENCE_MODE: 'kiro-cli',
      STACK_NAME: 'TestMainStackKiro',
    },
  });

  // The worker role can read the per-user Kiro API key parameters
  const policies = template.findResources('AWS::IAM::Policy');
  const statements = Object.values(policies).flatMap((p: any) => p.Properties.PolicyDocument.Statement);
  const perUserGrant = statements.find(
    (s: any) =>
      s.Action === 'ssm:GetParameter' &&
      JSON.stringify(s.Resource).includes('parameter/TestMainStackKiro/users/*/kiro-api-key')
  );
  expect(perUserGrant).toBeDefined();
});

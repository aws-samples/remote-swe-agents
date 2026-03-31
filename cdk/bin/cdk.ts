#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { MainStack, MainStackProps } from '../lib/cdk-stack';
import { AwsSolutionsChecks } from 'cdk-nag';
import { UsEast1Stack } from '../lib/us-east-1-stack';

const app = new cdk.App();

const targetEnv = process.env.TARGET_ENV ?? 'Sandbox';

// Parse IP addresses and country codes from environment variables
const parseCommaSeparatedList = (envVar: string | undefined): string[] | undefined => {
  return envVar
    ? envVar
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item)
    : undefined;
};

const allowedIpV4AddressRanges = parseCommaSeparatedList(process.env.ALLOWED_IPV4_CIDRS);
const allowedIpV6AddressRanges = parseCommaSeparatedList(process.env.ALLOWED_IPV6_CIDRS);
const allowedCountryCodes = parseCommaSeparatedList(process.env.ALLOWED_COUNTRY_CODES);

const virginia = new UsEast1Stack(app, `RemoteSweUsEast1Stack-${targetEnv}`, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',
  },
  crossRegionReferences: true,
  allowedIpV4AddressRanges,
  allowedIpV6AddressRanges,
  allowedCountryCodes,
});

if (process.env.BEDROCK_CRI_REGION_OVERRIDE) {
  if (!['global', 'us', 'eu', 'apac', 'jp', 'au'].includes(process.env.BEDROCK_CRI_REGION_OVERRIDE)) {
    throw new Error(
      `Invalid BEDROCK_CRI_REGION_OVERRIDE value: ${process.env.BEDROCK_CRI_REGION_OVERRIDE}. Choose from global, us, eu, apac, jp, au.`
    );
  }
}

const additionalPolicies = parseCommaSeparatedList(process.env.WORKER_ADDITIONAL_POLICIES);

const props: MainStackProps = {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  crossRegionReferences: true,
  signPayloadHandler: virginia.signPayloadHandler,
  cloudFrontWebAclArn: virginia.webAclArn,

  // === Slack Integration (optional) ===
  // Uncomment and configure to enable Slack bot integration.
  // You need to create SSM parameters first. See README for details.
  // slack: {
  //   botTokenParameterName: '/remote-swe/slack/bot-token',
  //   signingSecretParameterName: '/remote-swe/slack/signing-secret',
  // },

  // === GitHub Integration (optional) ===
  // Uncomment ONE of the following blocks to enable GitHub integration.
  // Option A: GitHub App
  // github: {
  //   privateKeyParameterName: '/remote-swe/github/app-private-key',
  //   appId: process.env.GITHUB_APP_ID!,
  //   installationId: process.env.GITHUB_INSTALLATION_ID!,
  // },
  // Option B: Personal Access Token
  // github: {
  //   personalAccessTokenParameterName: '/remote-swe/github/personal-access-token',
  // },

  ...(process.env.AWS_ACCOUNT_ID_LIST_FOR_LB
    ? {
        loadBalancing: {
          awsAccounts: process.env.AWS_ACCOUNT_ID_LIST_FOR_LB.split(','),
          roleName: process.env.ROLE_NAME_FOR_LB ?? 'bedrock-remote-swe-role',
        },
      }
    : {}),
  ...(additionalPolicies ? { additionalManagedPolicies: additionalPolicies } : {}),
  ...(process.env.VPC_ID ? { vpcId: process.env.VPC_ID } : {}),
  initialWebappUserEmail: process.env.INITIAL_WEBAPP_USER_EMAIL,
  bedrockCriRegionOverride: process.env.BEDROCK_CRI_REGION_OVERRIDE,
};

new MainStack(app, `RemoteSweStack-${targetEnv}`, {
  ...props,
});
// cdk.Aspects.of(app).add(new AwsSolutionsChecks());

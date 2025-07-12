#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { MainStack, MainStackProps } from '../lib/cdk-stack';
import { AwsSolutionsChecks } from 'cdk-nag';
import { UsEast1Stack } from '../lib/us-east-1-stack';
import { loadConfigFromEnv } from './config';

const app = new cdk.App();

// Load all configuration from environment variables
const config = loadConfigFromEnv();

const virginia = new UsEast1Stack(app, `RemoteSweUsEast1Stack-${config.targetEnv}`, {
  env: {
    account: config.cdkDefaultAccount,
    region: 'us-east-1',
  },
  crossRegionReferences: true,
  allowedIpV4AddressRanges: config.allowedIpV4AddressRanges,
  allowedIpV6AddressRanges: config.allowedIpV6AddressRanges,
  allowedCountryCodes: config.allowedCountryCodes,
});

const props: MainStackProps = {
  env: {
    account: config.cdkDefaultAccount,
    region: config.cdkDefaultRegion,
  },
  crossRegionReferences: true,
  signPayloadHandler: virginia.signPayloadHandler,
  cloudFrontWebAclArn: virginia.webAclArn,
  workerAmiIdParameterName: '/remote-swe/worker/ami-id',
  slack: {
    botTokenParameterName: '/remote-swe/slack/bot-token',
    signingSecretParameterName: '/remote-swe/slack/signing-secret',
    adminUserIdList: config.slackAdminUserIdList,
  },
  github: {
    ...(config.githubAppId
      ? {
          privateKeyParameterName: '/remote-swe/github/app-private-key',
          appId: config.githubAppId,
          installationId: config.githubInstallationId!,
        }
      : {
          personalAccessTokenParameterName: '/remote-swe/github/personal-access-token',
        }),
  },
  ...(config.awsAccountIdListForLb
    ? {
        loadBalancing: {
          awsAccounts: config.awsAccountIdListForLb,
          roleName: config.roleNameForLb ?? 'bedrock-remote-swe-role',
        },
      }
    : {}),
  ...(config.workerAdditionalPolicies ? { additionalManagedPolicies: config.workerAdditionalPolicies } : {}),
  ...(config.vpcId ? { vpcId: config.vpcId } : {}),
  initialWebappUserEmail: config.initialWebappUserEmail,
  ...(config.workerModelOverride ? { workerModelOverride: config.workerModelOverride } : {}),
};

new MainStack(app, `RemoteSweStack-${config.targetEnv}`, {
  ...props,
});
// cdk.Aspects.of(app).add(new AwsSolutionsChecks());

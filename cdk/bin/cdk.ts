#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { MainStack } from '../lib/cdk-stack';
import { AwsSolutionsChecks } from 'cdk-nag';
import { UsEast1Stack } from '../lib/us-east-1-stack';
import { createMainStackPropsFromConfig, loadConfigFromEnv } from './config';

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

// Create MainStackProps from config using the helper function
const props = createMainStackPropsFromConfig(config, virginia.signPayloadHandler, virginia.webAclArn);

new MainStack(app, `RemoteSweStack-${config.targetEnv}`, props);
// cdk.Aspects.of(app).add(new AwsSolutionsChecks());

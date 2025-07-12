import { MainStackProps } from '../lib/cdk-stack';

/**
 * Environment configuration interface containing all environment variables
 * used in the CDK application.
 */
export interface EnvironmentConfig {
  // General settings
  targetEnv: string;

  // Network/Security settings
  allowedIpV4AddressRanges?: string[];
  allowedIpV6AddressRanges?: string[];
  allowedCountryCodes?: string[];

  // AWS settings
  cdkDefaultAccount?: string;
  cdkDefaultRegion?: string;
  vpcId?: string;

  // Worker settings
  workerAdditionalPolicies?: string[];
  workerModelOverride?: string;

  // Slack settings
  slackAdminUserIdList?: string;

  // GitHub settings
  githubAppId?: string;
  githubInstallationId?: string;

  // Load balancing settings
  awsAccountIdListForLb?: string[];
  roleNameForLb?: string;

  // Web app settings
  initialWebappUserEmail?: string;
}

/**
 * Helper function to parse comma-separated environment variables into string arrays
 */
export const parseCommaSeparatedList = (envVar: string | undefined): string[] | undefined => {
  return envVar
    ? envVar
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item)
    : undefined;
};

/**
 * Load all configuration from environment variables
 */
export function loadConfigFromEnv(): EnvironmentConfig {
  const targetEnv = process.env.TARGET_ENV ?? 'Sandbox';

  const allowedIpV4AddressRanges = parseCommaSeparatedList(process.env.ALLOWED_IPV4_CIDRS);
  const allowedIpV6AddressRanges = parseCommaSeparatedList(process.env.ALLOWED_IPV6_CIDRS);
  const allowedCountryCodes = parseCommaSeparatedList(process.env.ALLOWED_COUNTRY_CODES);
  const workerAdditionalPolicies = parseCommaSeparatedList(process.env.WORKER_ADDITIONAL_POLICIES);
  const awsAccountIdListForLb = parseCommaSeparatedList(process.env.AWS_ACCOUNT_ID_LIST_FOR_LB);

  return {
    // General settings
    targetEnv,

    // Network/Security settings
    allowedIpV4AddressRanges,
    allowedIpV6AddressRanges,
    allowedCountryCodes,

    // AWS settings
    cdkDefaultAccount: process.env.CDK_DEFAULT_ACCOUNT,
    cdkDefaultRegion: process.env.CDK_DEFAULT_REGION,
    vpcId: process.env.VPC_ID,

    // Worker settings
    workerAdditionalPolicies,
    workerModelOverride: process.env.WORKER_MODEL_OVERRIDE,

    // Slack settings
    slackAdminUserIdList: process.env.SLACK_ADMIN_USER_ID_LIST,

    // GitHub settings
    githubAppId: process.env.GITHUB_APP_ID,
    githubInstallationId: process.env.GITHUB_INSTALLATION_ID,

    // Load balancing settings
    awsAccountIdListForLb,
    roleNameForLb: process.env.ROLE_NAME_FOR_LB,

    // Web app settings
    initialWebappUserEmail: process.env.INITIAL_WEBAPP_USER_EMAIL,
  };
}

/**
 * Creates MainStackProps from environment configuration
 * This function transforms the environment config into the shape expected by MainStack
 */
export function createMainStackPropsFromConfig(
  config: EnvironmentConfig,
  signPayloadHandler: any,
  webAclArn?: string
): MainStackProps {
  return {
    env: {
      account: config.cdkDefaultAccount,
      region: config.cdkDefaultRegion,
    },
    crossRegionReferences: true,
    signPayloadHandler,
    cloudFrontWebAclArn: webAclArn,
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
}

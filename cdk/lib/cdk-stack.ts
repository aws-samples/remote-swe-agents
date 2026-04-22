import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { SlackBolt } from './constructs/slack-bolt';
import { Worker } from './constructs/worker';
import { SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { Storage } from './constructs/storage';
import { EC2GarbageCollector } from './constructs/ec2-gc';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { BlockPublicAccess, Bucket, ObjectOwnership } from 'aws-cdk-lib/aws-s3';
import { RemovalPolicy } from 'aws-cdk-lib';
import { EdgeFunction } from './constructs/cf-lambda-furl-service/edge-function';
import { ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import { HostedZone } from 'aws-cdk-lib/aws-route53';
import { Auth } from './constructs/auth';
import { AsyncJob } from './constructs/async-job';
import { Webapp } from './constructs/webapp';
import { IRepository } from 'aws-cdk-lib/aws-ecr';
import { VapidKeys } from './constructs/vapid-keys';

export interface MainStackProps extends cdk.StackProps {
  readonly signPayloadHandler: EdgeFunction;
  readonly domainName?: string;
  readonly sharedCertificate?: ICertificate;
  readonly cloudFrontWebAclArn?: string;
  readonly vpcId?: string;

  readonly slack?: {
    botTokenParameterName: string;
    signingSecretParameterName: string;
    adminUserIdList?: string;
  };
  readonly github?:
    | {
        appId: string;
        installationId: string;
        privateKeyParameterName: string;
      }
    | {
        personalAccessTokenParameterName: string;
      };
  readonly loadBalancing?: {
    awsAccounts: string[];
    roleName: string;
  };
  readonly additionalManagedPolicies?: string[];

  /**
   * EC2 instance type for workers (e.g. t3.large, t3.medium).
   * @default 't3.large'
   */
  readonly workerInstanceType?: string;

  /**
   * Use Spot instances for workers to reduce cost. Falls back to On-Demand if Spot capacity is unavailable.
   * @default false
   */
  readonly workerUseSpot?: boolean;

  /**
   * When user ends a session, terminate the EC2 instance instead of leaving it stopped (reduces EBS cost).
   * @default false
   */
  readonly workerTerminateOnSessionEnd?: boolean;

  /**
   * The email address of the initial webapp user to be created.
   * @default No users are created.
   */
  readonly initialWebappUserEmail?: string;

  /**
   * An AWS region to override the Bedrock cross-region profile region. (Choose from global, us, eu, apac, jp, au)
   * @default 'us' (Use US CRI profile)
   */
  readonly bedrockCriRegionOverride?: string;

  /**
   * LLM provider to use ('bedrock' or 'anthropic')
   * @default 'bedrock'
   */
  readonly llmProvider?: string;

  /**
   * Anthropic API Key parameter name (required when llmProvider is 'anthropic')
   */
  readonly anthropicApiKeyParameterName?: string;

  /**
   * Deploy Bedrock Agent Core Runtime. Set to false to use Claude via Anthropic only (avoids Bedrock agent limit).
   * @default false
   */
  readonly deployBedrockRuntime?: boolean;

  /**
   * Allow new sessions only from Slack (disable WebApp and API session creation).
   * @default false
   */
  readonly slackOnlySessionCreation?: boolean;
}

export class MainStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MainStackProps) {
    super(scope, id, { ...props, description: `${props.description ?? 'Remote SWE Agents stack'} (uksb-lv52f92xel)` });

    const botToken = props.slack
      ? StringParameter.fromStringParameterAttributes(this, 'SlackBotToken', {
          parameterName: props.slack.botTokenParameterName,
          forceDynamicReference: true,
        })
      : undefined;

    const signingSecret = props.slack
      ? StringParameter.fromStringParameterAttributes(this, 'SlackSigningSecret', {
          parameterName: props.slack.signingSecretParameterName,
          forceDynamicReference: true,
        })
      : undefined;

    const workerAmiIdParameter = new StringParameter(this, 'WorkerAmiId', {
      parameterName: `/${this.stackName}/worker-ami-id`,
      stringValue: 'pending-initial-build',
    });

    const hostedZone = props.domainName
      ? HostedZone.fromLookup(this, 'HostedZone', {
          domainName: props.domainName,
        })
      : undefined;

    const accessLogBucket = new Bucket(this, 'AccessLog', {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      enforceSSL: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      objectOwnership: ObjectOwnership.OBJECT_WRITER,
    });

    const originNameParameter = new StringParameter(this, 'WebappOriginNameParameter', {
      stringValue: 'dummy', // this will be updated from the webapp construct.
    });

    const vpc = props.vpcId
      ? Vpc.fromLookup(this, 'VpcV2', { vpcId: props.vpcId })
      : new Vpc(this, 'VpcV2', {
          subnetConfiguration: [
            {
              // We use public subnets for worker EC2 instances. Here are the reasons:
              //   1. to remove NAT Gateway cost
              //   2. to avoid IP-address-based throttling/filtering from external services
              // All the instances are securely protected by security groups without any inbound rules.
              subnetType: SubnetType.PUBLIC,
              name: 'Public',
              cidrMask: 20,
            },
          ],
        });

    const storage = new Storage(this, 'Storage', { accessLogBucket });

    const anthropicApiKeyParameter = props.anthropicApiKeyParameterName
      ? StringParameter.fromStringParameterAttributes(this, 'AnthropicApiKey', {
          parameterName: props.anthropicApiKeyParameterName,
          forceDynamicReference: true,
        })
      : undefined;

    const auth = new Auth(this, 'Auth', {
      hostedZone,
      sharedCertificate: props.sharedCertificate,
      initialUserEmail: props.initialWebappUserEmail,
    });

    const vapidKeys = new VapidKeys(this, 'VapidKeys');

    const worker = new Worker(this, 'Worker', {
      vpc,
      storageTable: storage.table,
      imageBucket: storage.bucket,
      slackBotTokenParameter: botToken,
      ...(props.github && 'appId' in props.github
        ? {
            gitHubApp: {
              appId: props.github.appId,
              installationId: props.github.installationId,
              privateKeyParameterName: props.github.privateKeyParameterName,
            },
          }
        : props.github && 'personalAccessTokenParameterName' in props.github
          ? {
              githubPersonalAccessTokenParameter: StringParameter.fromStringParameterAttributes(
                this,
                'GitHubPersonalAccessToken',
                {
                  parameterName: props.github.personalAccessTokenParameterName,
                  forceDynamicReference: true,
                }
              ),
            }
          : {}),
      loadBalancing: props.loadBalancing,
      accessLogBucket,
      amiIdParameterName: workerAmiIdParameter.parameterName,
      amiIdParameter: workerAmiIdParameter,
      webappOriginSourceParameter: originNameParameter,
      additionalManagedPolicies: props.additionalManagedPolicies,
      bedrockCriRegionOverride: props.bedrockCriRegionOverride,
      llmProvider: props.llmProvider,
      anthropicApiKeyParameter,
      deployBedrockRuntime: props.deployBedrockRuntime,
      workerInstanceType: props.workerInstanceType,
      userPool: auth.userPool,
      cognitoDomainName: auth.domainName,
      vapidKeys,
    });

    worker.bus.addUserPoolProvider(auth.userPool);

    const asyncJob = new AsyncJob(this, 'AsyncJob', { storage });

    const webapp = new Webapp(this, 'Webapp', {
      storage,
      hostedZone,
      certificate: props.sharedCertificate,
      signPayloadHandler: props.signPayloadHandler,
      webAclArn: props.cloudFrontWebAclArn,
      accessLogBucket,
      auth,
      launchTemplateId: worker.launchTemplate.launchTemplateId!,
      subnetIdListForWorkers: vpc.publicSubnets.map((s) => s.subnetId).join(','),
      workerBus: worker.bus,
      asyncJob,
      workerAmiIdParameter,
      originNameParameter,
      agentCoreRuntime: worker.agentCoreRuntime,
      bedrockCriRegionOverride: props.bedrockCriRegionOverride,
      workerUseSpot: props.workerUseSpot,
      workerTerminateOnSessionEnd: props.workerTerminateOnSessionEnd,
      slackOnlySessionCreation: props.slackOnlySessionCreation,
      vapidKeys,
    });

    if (props.slack && botToken && signingSecret) {
      new SlackBolt(this, 'SlackBolt', {
        botTokenParameter: botToken,
        signingSecretParameter: signingSecret,
        launchTemplateId: worker.launchTemplate.launchTemplateId!,
        subnetIdListForWorkers: vpc.publicSubnets.map((s) => s.subnetId).join(','),
        workerBus: worker.bus,
        storage,
        adminUserIdList: props.slack.adminUserIdList,
        workerLogGroupName: worker.logGroup.logGroupName,
        workerAmiIdParameter,
        webappOriginNameParameter: originNameParameter,
        agentCoreRuntime: worker.agentCoreRuntime,
        workerUseSpot: props.workerUseSpot,
      });
    }

    new EC2GarbageCollector(this, 'EC2GarbageCollector', {
      expirationInDays: 1,
      imageRecipeName: worker.imageBuilder.imageRecipeName,
      workerAmiIdParameter: workerAmiIdParameter,
    });

    new cdk.CfnOutput(this, 'FrontendDomainName', {
      value: webapp.baseUrl,
    });
  }
}

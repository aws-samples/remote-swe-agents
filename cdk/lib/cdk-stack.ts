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

export interface MainStackProps extends cdk.StackProps {
  readonly signPayloadHandler: EdgeFunction;
  readonly domainName?: string;
  readonly sharedCertificate?: ICertificate;
  readonly cloudFrontWebAclArn?: string;
  readonly vpcId?: string;

  readonly slack: {
    botTokenParameterName: string;
    signingSecretParameterName: string;
    adminUserIdList?: string;
  };
  readonly github:
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
  readonly workerAmiIdParameterName: string;
  readonly additionalAwsManagedPolicies?: string[];
  readonly initialWebappUserEmail?: string;
}

export class MainStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MainStackProps) {
    super(scope, id, { ...props, description: `${props.description ?? 'Remote SWE Agents stack'} (uksb-lv52f92xel)` });

    const botToken = StringParameter.fromStringParameterAttributes(this, 'SlackBotToken', {
      parameterName: props.slack.botTokenParameterName,
      forceDynamicReference: true,
    });

    const signingSecret = StringParameter.fromStringParameterAttributes(this, 'SlackSigningSecret', {
      parameterName: props.slack.signingSecretParameterName,
      forceDynamicReference: true,
    });

    const workerAmiIdParameter = StringParameter.fromStringParameterAttributes(this, 'WorkerAmiId', {
      parameterName: props.workerAmiIdParameterName,
      forceDynamicReference: true,
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

    const worker = new Worker(this, 'Worker', {
      vpc,
      storageTable: storage.table,
      imageBucket: storage.bucket,
      slackBotTokenParameter: botToken,
      ...('appId' in props.github
        ? {
            gitHubApp: {
              appId: props.github.appId,
              installationId: props.github.installationId,
              privateKeyParameterName: props.github.privateKeyParameterName,
            },
          }
        : {
            githubPersonalAccessTokenParameter: StringParameter.fromStringParameterAttributes(
              this,
              'GitHubPersonalAccessToken',
              {
                parameterName: props.github.personalAccessTokenParameterName,
                forceDynamicReference: true,
              }
            ),
          }),
      loadBalancing: props.loadBalancing,
      accessLogBucket,
      amiIdParameterName: workerAmiIdParameter.parameterName,
      additionalAwsManagedPolicies: props.additionalAwsManagedPolicies,
    });

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
    });

    new EC2GarbageCollector(this, 'EC2GarbageCollector', {
      expirationInDays: 1,
      imageRecipeName: worker.imageBuilder.imageRecipeName,
    });

    const auth = new Auth(this, 'Auth', {
      hostedZone,
      sharedCertificate: props.sharedCertificate,
      initialUserEmail: props.initialWebappUserEmail,
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
    });

    new cdk.CfnOutput(this, 'FrontendDomainName', {
      value: webapp.baseUrl,
    });
  }
}

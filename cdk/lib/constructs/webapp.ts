import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { Repository } from 'aws-cdk-lib/aws-ecr';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { DockerImageFunction, DockerImageCode, Architecture } from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { readFileSync } from 'fs';
import { CloudFrontLambdaFunctionUrlService } from './cf-lambda-furl-service/service';
import { IHostedZone } from 'aws-cdk-lib/aws-route53';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { EdgeFunction } from './cf-lambda-furl-service/edge-function';
import { ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import { Auth } from './auth/';
import { ContainerImageBuild } from 'deploy-time-build';
import { join } from 'path';
import { AsyncJob } from './async-job';
import { IStringParameter } from 'aws-cdk-lib/aws-ssm';
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from 'aws-cdk-lib/custom-resources';
import { Storage } from './storage';
import { WorkerBus } from './worker/bus';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { LambdaWarmer } from './lambda-warmer';
import { AgentCoreRuntime } from './worker/agent-core-runtime';

export interface WebappProps {
  storage: Storage;
  signPayloadHandler: EdgeFunction;
  accessLogBucket: Bucket;
  auth: Auth;
  asyncJob: AsyncJob;
  launchTemplateId: string;
  subnetIdListForWorkers: string;
  workerBus: WorkerBus;
  workerAmiIdParameter: IStringParameter;
  originNameParameter: IStringParameter;
  /** When undefined, Bedrock Agent Core is not deployed (use Claude via Anthropic API). */
  agentCoreRuntime?: AgentCoreRuntime;

  hostedZone?: IHostedZone;
  certificate?: ICertificate;
  /**
   * Use root domain
   */
  subDomain?: string;
  /**
   * The ARN of the WAF Web ACL to associate with the CloudFront distribution
   * @default no WAF Web ACL
   */
  webAclArn?: string;

  bedrockCriRegionOverride?: string;

  /**
   * Use Spot instances for workers. Set WORKER_USE_SPOT in Lambda environment.
   * @default false
   */
  workerUseSpot?: boolean;

  /**
   * When user ends session, terminate instance (WORKER_TERMINATE_ON_SESSION_END). Reduces EBS cost.
   * @default false
   */
  workerTerminateOnSessionEnd?: boolean;
}

export class Webapp extends Construct {
  public readonly baseUrl: string;

  constructor(scope: Construct, id: string, props: WebappProps) {
    super(scope, id);

    const { storage, hostedZone, auth, subDomain, workerBus, asyncJob, originNameParameter } = props;

    // ECR repository name must be lowercase (and digits, . _ - only) per AWS constraint
    const webappRepository = new Repository(this, 'BuildRepository', {
      repositoryName: 'remote-swe-webapp',
      removalPolicy: RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });

    // Use ContainerImageBuild (CodeBuild) to inject deploy-time values in the build environment
    const image = new ContainerImageBuild(this, 'Build', {
      directory: join('..'),
      file: join('docker', 'webapp.Dockerfile'),
      platform: Platform.LINUX_ARM64,
      repository: webappRepository,
      exclude: [
        ...readFileSync('.dockerignore').toString().split('\n'),
        'packages/github-actions',
        'packages/slack-bolt-app',
        'packages/worker',
      ],
      tagPrefix: 'webapp-starter-',
      buildArgs: {
        ALLOWED_ORIGIN_HOST: hostedZone ? `*.${hostedZone.zoneName}` : '*.cloudfront.net',
        SKIP_TS_BUILD: 'true',
        NEXT_PUBLIC_EVENT_HTTP_ENDPOINT: workerBus.httpEndpoint,
        NEXT_PUBLIC_AWS_REGION: Stack.of(this).region,
        NEXT_PUBLIC_BEDROCK_CRI_REGION_OVERRIDE: props.bedrockCriRegionOverride ?? '',
      },
    });
    const handler = new DockerImageFunction(this, 'Handler', {
      code: image.toLambdaDockerImageCode(),
      timeout: Duration.minutes(3),
      environment: {
        COGNITO_DOMAIN: auth.domainName,
        USER_POOL_ID: auth.userPool.userPoolId,
        USER_POOL_CLIENT_ID: auth.client.userPoolClientId,
        ASYNC_JOB_HANDLER_ARN: asyncJob.handler.functionArn,
        WORKER_LAUNCH_TEMPLATE_ID: props.launchTemplateId,
        WORKER_AMI_PARAMETER_NAME: props.workerAmiIdParameter.parameterName,
        SUBNET_ID_LIST: props.subnetIdListForWorkers,
        EVENT_HTTP_ENDPOINT: props.workerBus.httpEndpoint,
        TABLE_NAME: storage.table.tableName,
        BUCKET_NAME: storage.bucket.bucketName,
        AGENT_RUNTIME_ARN: props.agentCoreRuntime?.runtimeArn ?? '',
        BEDROCK_CRI_REGION_OVERRIDE: props.bedrockCriRegionOverride ?? '',
        ...(props.workerUseSpot ? { WORKER_USE_SPOT: 'true' } : {}),
        ...(props.workerTerminateOnSessionEnd ? { WORKER_TERMINATE_ON_SESSION_END: 'true' } : {}),
      },
      memorySize: 1769,
      architecture: Architecture.ARM_64,
    });
    props.workerAmiIdParameter.grantRead(handler);
    asyncJob.handler.grantInvoke(handler);
    storage.table.grantReadWriteData(handler);
    storage.bucket.grantReadWrite(handler);
    workerBus.api.grantPublish(handler);
    props.agentCoreRuntime?.grantInvoke(handler);

    handler.addToRolePolicy(
      new PolicyStatement({
        actions: [
          // required to run instances from launch template
          'ec2:RunInstances',
          'ec2:DescribeInstances',
          'iam:PassRole',
          'ec2:CreateTags',
          'ec2:StartInstances',
        ],
        resources: ['*'],
      })
    );
    if (props.workerUseSpot) {
      handler.addToRolePolicy(
        new PolicyStatement({
          actions: ['iam:CreateServiceLinkedRole'],
          resources: ['*'],
          conditions: {
            StringEquals: { 'iam:AWSServiceName': 'spot.amazonaws.com' },
          },
        })
      );
    }

    const service = new CloudFrontLambdaFunctionUrlService(this, 'Resource', {
      subDomain,
      handler,
      serviceName: 'RemoteSweAgentsWebapp',
      hostedZone,
      certificate: props.certificate,
      accessLogBucket: props.accessLogBucket,
      signPayloadHandler: props.signPayloadHandler,
      webAclArn: props.webAclArn,
    });
    this.baseUrl = service.url;

    if (hostedZone) {
      auth.addAllowedCallbackUrls(
        `http://localhost:3011/api/auth/sign-in-callback`,
        `http://localhost:3011/api/auth/sign-out-callback`
      );
      auth.addAllowedCallbackUrls(
        `${this.baseUrl}/api/auth/sign-in-callback`,
        `${this.baseUrl}/api/auth/sign-out-callback`
      );
      handler.addEnvironment('APP_ORIGIN', service.url);
    } else {
      auth.updateAllowedCallbackUrls(
        [`${this.baseUrl}/api/auth/sign-in-callback`, `http://localhost:3011/api/auth/sign-in-callback`],
        [`${this.baseUrl}/api/auth/sign-out-callback`, `http://localhost:3011/api/auth/sign-out-callback`]
      );

      originNameParameter.grantRead(handler);
      handler.addEnvironment('APP_ORIGIN_SOURCE_PARAMETER', originNameParameter.parameterName);
    }

    // We need to pass APP_ORIGIN environment variable for callback URL,
    // but we cannot know CloudFront domain before deploying Lambda function.
    // To avoid the circular dependency, we fetch the domain name on runtime.
    new AwsCustomResource(this, 'UpdateOriginNameParameter', {
      onUpdate: {
        service: 'ssm',
        action: 'putParameter',
        parameters: {
          Name: originNameParameter.parameterName,
          Value: service.url,
          Overwrite: true,
        },
        physicalResourceId: PhysicalResourceId.of(originNameParameter.parameterName),
      },
      policy: AwsCustomResourcePolicy.fromSdkCalls({
        resources: [originNameParameter.parameterArn],
      }),
    });

    if (process.env.ENABLE_LAMBDA_WARMER) {
      const warmer = new LambdaWarmer(this, 'LambdaWarmer', {});
      warmer.addTarget('Webapp', `${this.baseUrl}/api/health/warm`, 5);
    }
  }
}

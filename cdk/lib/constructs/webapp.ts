import { IgnoreMode, Duration, CfnOutput, Stack } from 'aws-cdk-lib';
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
import { IStringParameter, StringParameter } from 'aws-cdk-lib/aws-ssm';
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from 'aws-cdk-lib/custom-resources';
import { Storage } from './storage';
import { WorkerBus } from './worker/bus';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { LambdaWarmer } from './lambda-warmer';

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
}

export class Webapp extends Construct {
  public readonly baseUrl: string;
  public readonly originSourceParameter: IStringParameter;

  constructor(scope: Construct, id: string, props: WebappProps) {
    super(scope, id);

    const { storage, hostedZone, auth, subDomain, workerBus, asyncJob } = props;

    // Use ContainerImageBuild to inject deploy-time values in the build environment
    const image = new ContainerImageBuild(this, 'Build', {
      directory: join('..'),
      file: join('docker', 'webapp.Dockerfile'),
      platform: Platform.LINUX_ARM64,
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
      },
      memorySize: 1769,
      architecture: Architecture.ARM_64,
    });
    props.workerAmiIdParameter.grantRead(handler);
    asyncJob.handler.grantInvoke(handler);
    storage.table.grantReadWriteData(handler);
    storage.bucket.grantReadWrite(handler);
    workerBus.api.grantPublish(handler);

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
      this.originSourceParameter = new StringParameter(this, 'OriginSourceParameter', {
        stringValue: service.url,
      });
    } else {
      auth.updateAllowedCallbackUrls(
        [`${this.baseUrl}/api/auth/sign-in-callback`, `http://localhost:3011/api/auth/sign-in-callback`],
        [`${this.baseUrl}/api/auth/sign-out-callback`, `http://localhost:3011/api/auth/sign-out-callback`]
      );

      // Create parameter and expose it publicly for other constructs to use
      const originSourceParameter = new StringParameter(this, 'OriginSourceParameter', {
        stringValue: 'dummy',
      });
      this.originSourceParameter = originSourceParameter;
      originSourceParameter.grantRead(handler);
      handler.addEnvironment('APP_ORIGIN_SOURCE_PARAMETER', originSourceParameter.parameterName);

      // We need to pass APP_ORIGIN environment variable for callback URL,
      // but we cannot know CloudFront domain before deploying Lambda function.
      // To avoid the circular dependency, we fetch the domain name on runtime.
      new AwsCustomResource(this, 'UpdateAmplifyOriginSourceParameter', {
        onUpdate: {
          service: 'ssm',
          action: 'putParameter',
          parameters: {
            Name: originSourceParameter.parameterName,
            Value: service.url,
            Overwrite: true,
          },
          physicalResourceId: PhysicalResourceId.of(originSourceParameter.parameterName),
        },
        policy: AwsCustomResourcePolicy.fromSdkCalls({
          resources: [originSourceParameter.parameterArn],
        }),
      });
    }

    if (process.env.ENABLE_LAMBDA_WARMER) {
      const warmer = new LambdaWarmer(this, 'LambdaWarmer', {});
      warmer.addTarget('Webapp', `${this.baseUrl}/api/health/warm`, 5);
    }
  }
}

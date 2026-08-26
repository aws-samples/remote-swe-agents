import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { CfnStage, HttpApi } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { IRole, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Architecture, DockerImageFunction } from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { WorkerBus } from '../worker/bus';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { IStringParameter } from 'aws-cdk-lib/aws-ssm';
import { join } from 'path';
import { readFileSync } from 'fs';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { Storage } from '../storage';
import { AgentCoreRuntime } from '../worker/agent-core-runtime';
import { ContainerImageBuild } from '@cdklabs/deploy-time-build';
import { grantWorkerLaunchCapability } from '../worker/grant-worker-launch';

export interface SlackBoltProps {
  signingSecretParameter: IStringParameter;
  botTokenParameter: IStringParameter;
  launchTemplateId: string;
  subnetIdListForWorkers: string;
  workerBus: WorkerBus;
  storage: Storage;
  adminUserIdList?: string;
  workerLogGroupName: string;
  workerAmiIdParameter: IStringParameter;
  webappOriginNameParameter: IStringParameter;
  agentCoreRuntime: AgentCoreRuntime;
  workerInstanceRole: IRole;
}

export class SlackBolt extends Construct {
  constructor(scope: Construct, id: string, props: SlackBoltProps) {
    super(scope, id);

    const { botTokenParameter, signingSecretParameter, webappOriginNameParameter } = props;

    const slackImage = new ContainerImageBuild(this, 'Image', {
      directory: '..',
      file: join('docker', 'slack-bolt-app.Dockerfile'),
      exclude: readFileSync('.dockerignore').toString().split('\n'),
      platform: Platform.LINUX_ARM64,
    });

    const asyncHandler = new DockerImageFunction(this, 'AsyncHandler', {
      code: slackImage.toLambdaDockerImageCode({ cmd: ['async-handler.handler'] }),
      timeout: Duration.minutes(10),
      environment: {
        BOT_TOKEN: botTokenParameter.stringValue,
        EVENT_HTTP_ENDPOINT: props.workerBus.httpEndpoint,
        TABLE_NAME: props.storage.table.tableName,
        BUCKET_NAME: props.storage.bucket.bucketName,
        AGENT_RUNTIME_ARN: props.agentCoreRuntime.runtimeArn,
      },
      architecture: Architecture.ARM_64,
    });
    const workerLaunchEnv = grantWorkerLaunchCapability({
      grantee: asyncHandler,
      amiIdParameter: props.workerAmiIdParameter,
      launchTemplateId: props.launchTemplateId,
      subnetIdListForWorkers: props.subnetIdListForWorkers,
      workerInstanceRole: props.workerInstanceRole,
    });
    for (const [key, value] of Object.entries(workerLaunchEnv)) {
      asyncHandler.addEnvironment(key, value);
    }
    props.storage.table.grantReadWriteData(asyncHandler);
    props.storage.bucket.grantReadWrite(asyncHandler);
    props.workerBus.api.grantPublish(asyncHandler);
    props.agentCoreRuntime.grantInvoke(asyncHandler);

    const handler = new DockerImageFunction(this, 'Handler', {
      code: slackImage.toLambdaDockerImageCode(),
      timeout: Duration.seconds(29),
      memorySize: 256,
      environment: {
        SIGNING_SECRET: signingSecretParameter.stringValue,
        BOT_TOKEN: botTokenParameter.stringValue,
        ASYNC_LAMBDA_NAME: asyncHandler.functionName,
        EVENT_HTTP_ENDPOINT: props.workerBus.httpEndpoint,
        TABLE_NAME: props.storage.table.tableName,
        BUCKET_NAME: props.storage.bucket.bucketName,
        LOG_GROUP_NAME: props.workerLogGroupName,
        WEBAPP_ORIGIN_NAME_PARAMETER: webappOriginNameParameter.parameterName,
        ...(props.adminUserIdList ? { ADMIN_USER_ID_LIST: props.adminUserIdList } : {}),
      },
      architecture: Architecture.ARM_64,
    });
    webappOriginNameParameter.grantRead(handler);
    asyncHandler.grantInvoke(handler);
    props.storage.table.grantReadWriteData(handler);
    props.storage.bucket.grantReadWrite(handler);
    props.workerBus.api.grantPublish(handler);

    const api = new HttpApi(this, 'Api', {
      description: 'slack bolt app',
      defaultIntegration: new HttpLambdaIntegration('Integration', handler),
    });
    // https://github.com/aws/aws-cdk/issues/11100#issuecomment-782176520
    const accessLogGroup = new LogGroup(this, 'AccessLog', {
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const defaultStage = api.defaultStage?.node.defaultChild as CfnStage;
    defaultStage.accessLogSettings = {
      destinationArn: accessLogGroup.logGroupArn,
      format: JSON.stringify({
        requestId: '$context.requestId',
        ip: '$context.identity.sourceIp',
        caller: '$context.identity.caller',
        user: '$context.identity.user',
        requestTime: '$context.requestTime',
        httpMethod: '$context.httpMethod',
        resourcePath: '$context.resourcePath',
        status: '$context.status',
        protocol: '$context.protocol',
        responseLength: '$context.responseLength',
      }),
    };

    asyncHandler.addToRolePolicy(
      new PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: ['*'],
      })
    );

    new CfnOutput(this, 'EndpointUrl', { value: api.apiEndpoint });
  }
}

import { CfnOutput, Duration, IgnoreMode, RemovalPolicy } from 'aws-cdk-lib';
import { CfnStage, HttpApi } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Architecture, DockerImageCode, DockerImageFunction } from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { WorkerBus } from '../worker/bus';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { IStringParameter, StringParameter } from 'aws-cdk-lib/aws-ssm';
import { join } from 'path';
import { readFileSync } from 'fs';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { Storage } from '../storage';

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
}

export class SlackBolt extends Construct {
  constructor(scope: Construct, id: string, props: SlackBoltProps) {
    super(scope, id);

    const { botTokenParameter, signingSecretParameter } = props;
    const asyncHandler = new DockerImageFunction(this, 'AsyncHandler', {
      code: DockerImageCode.fromImageAsset('..', {
        file: join('docker', 'slack-bolt-app.Dockerfile'),
        exclude: readFileSync('.dockerignore').toString().split('\n'),
        cmd: ['async-handler.handler'],
        platform: Platform.LINUX_ARM64,
      }),
      timeout: Duration.minutes(10),
      environment: {
        WORKER_LAUNCH_TEMPLATE_ID: props.launchTemplateId,
        WORKER_AMI_PARAMETER_NAME: props.workerAmiIdParameter.parameterName,
        SUBNET_ID_LIST: props.subnetIdListForWorkers,
        BOT_TOKEN: botTokenParameter.stringValue,
        EVENT_HTTP_ENDPOINT: props.workerBus.httpEndpoint,
        TABLE_NAME: props.storage.table.tableName,
        BUCKET_NAME: props.storage.bucket.bucketName,
      },
      architecture: Architecture.ARM_64,
    });
    props.workerAmiIdParameter.grantRead(asyncHandler);
    props.storage.table.grantReadWriteData(asyncHandler);
    props.storage.bucket.grantReadWrite(asyncHandler);
    props.workerBus.api.grantPublish(asyncHandler);

    const originSourceParameter = StringParameter.fromStringParameterName(
      this,
      'OriginSourceParameter',
      'remote-swe-agents-webapp-originSourceParameter'
    );

    const handler = new DockerImageFunction(this, 'Handler', {
      code: DockerImageCode.fromImageAsset('..', {
        file: join('docker', 'slack-bolt-app.Dockerfile'),
        exclude: readFileSync('.dockerignore').toString().split('\n'),
        platform: Platform.LINUX_ARM64,
      }),
      timeout: Duration.seconds(29),
      environment: {
        SIGNING_SECRET: signingSecretParameter.stringValue,
        BOT_TOKEN: botTokenParameter.stringValue,
        ASYNC_LAMBDA_NAME: asyncHandler.functionName,
        EVENT_HTTP_ENDPOINT: props.workerBus.httpEndpoint,
        TABLE_NAME: props.storage.table.tableName,
        BUCKET_NAME: props.storage.bucket.bucketName,
        LOG_GROUP_NAME: props.workerLogGroupName,
        APP_ORIGIN_SOURCE_PARAMETER: originSourceParameter.parameterName,
        ...(props.adminUserIdList ? { ADMIN_USER_ID_LIST: props.adminUserIdList } : {}),
      },
      architecture: Architecture.ARM_64,
    });
    originSourceParameter.grantRead(handler);
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
        actions: [
          'bedrock:InvokeModel',
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

    new CfnOutput(this, 'EndpointUrl', { value: api.apiEndpoint });
  }
}

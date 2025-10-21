import { CfnOutput, Names, Stack } from 'aws-cdk-lib';
import { ITableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { DockerImageAsset, Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { IGrantable, IPrincipal, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { IBucket } from 'aws-cdk-lib/aws-s3';
import { IStringParameter } from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { readFileSync } from 'fs';
import { join } from 'path';
import { WorkerBus } from './bus';
import { CfnRuntime } from 'aws-cdk-lib/aws-bedrockagentcore';

export interface AgentCoreRuntimeProps {
  storageTable: ITableV2;
  imageBucket: IBucket;
  bus: WorkerBus;
  slackBotTokenParameter: IStringParameter;
  gitHubApp?: {
    privateKeyParameterName: string;
    appId: string;
    installationId: string;
  };
  gitHubAppPrivateKeyParameter?: IStringParameter;
  githubPersonalAccessTokenParameter?: IStringParameter;
  loadBalancing?: {
    awsAccounts: string[];
    roleName: string;
  };
  accessLogBucket: IBucket;
  amiIdParameterName: string;
  webappOriginSourceParameter: IStringParameter;
  bedrockCriRegionOverride?: string;
}

export class AgentCoreRuntime extends Construct implements IGrantable {
  public grantPrincipal: IPrincipal;
  public runtimeArn: string;

  constructor(scope: Construct, id: string, props: AgentCoreRuntimeProps) {
    super(scope, id);

    const role = new Role(this, 'Role', {
      assumedBy: ServicePrincipal.fromStaticServicePrincipleName('bedrock-agentcore.amazonaws.com'),
    });
    this.grantPrincipal = role;

    const image = new DockerImageAsset(this, 'WorkerImage', {
      directory: '..',
      file: join('docker', 'agent.Dockerfile'),
      exclude: readFileSync('.dockerignore').toString().split('\n'),
      platform: Platform.LINUX_ARM64,
    });
    image.repository.grantPull(role);

    role.addToPrincipalPolicy(
      new PolicyStatement({
        actions: [
          'ecr:GetAuthorizationToken',
          'xray:PutTraceSegments',
          'xray:PutTelemetryRecords',
          'xray:GetSamplingRules',
          'xray:GetSamplingTargets',
          'cloudwatch:PutMetricData',
          'logs:DescribeLogStreams',
          'logs:DescribeLogGroups',
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
          'bedrock-agentcore:GetWorkloadAccessToken',
          'bedrock-agentcore:GetWorkloadAccessTokenForJWT',
          'bedrock-agentcore:GetWorkloadAccessTokenForUserId',
        ],
        resources: ['*'],
      })
    );
    role.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: ['*'],
      })
    );
    props.storageTable.grantReadWriteData(role);
    props.imageBucket.grantReadWrite(role);
    props.gitHubAppPrivateKeyParameter?.grantRead(role);
    props.githubPersonalAccessTokenParameter?.grantRead(role);
    props.slackBotTokenParameter.grantRead(role);
    props.bus.api.grantPublishAndSubscribe(role);
    props.bus.api.grantConnect(role);

    const runtime = new CfnRuntime(this, 'Runtime', {
      agentRuntimeName: Names.uniqueResourceName(this, { maxLength: 40 }),
      agentRuntimeArtifact: {
        containerConfiguration: {
          containerUri: image.imageUri,
        },
      },
      networkConfiguration: {
        networkMode: 'PUBLIC',
      },
      roleArn: role.roleArn,
      protocolConfiguration: 'HTTP',
      environmentVariables: {
        AWS_REGION: Stack.of(this).region,
        WORKER_RUNTIME: 'agent-core',
        EVENT_HTTP_ENDPOINT: props.bus.httpEndpoint,
        GITHUB_APP_PRIVATE_KEY_PARAMETER_NAME: props.gitHubAppPrivateKeyParameter?.parameterName ?? '',
        GITHUB_APP_ID: props.gitHubApp?.appId ?? '',
        GITHUB_APP_INSTALLATION_ID: props.gitHubApp?.installationId ?? '',
        TABLE_NAME: props.storageTable.tableName,
        BUCKET_NAME: props.imageBucket.bucketName,
        WEBAPP_ORIGIN_NAME_PARAMETER: props.webappOriginSourceParameter.parameterName,
        // BEDROCK_AWS_ACCOUNTS: props.loadBalancing?.awsAccounts.join(',') ?? '',
        // BEDROCK_AWS_ROLE_NAME: props.loadBalancing?.roleName ?? '',
        SLACK_BOT_TOKEN_PARAMETER_NAME: props.slackBotTokenParameter.parameterName ?? '',
        GITHUB_PERSONAL_ACCESS_TOKEN_PARAMETER_NAME: props.githubPersonalAccessTokenParameter?.parameterName ?? '',
        BEDROCK_CRI_REGION_OVERRIDE: props.bedrockCriRegionOverride ?? '',
      },
    });
    runtime.node.addDependency(role);

    this.runtimeArn = runtime.attrAgentRuntimeArn;
    new CfnOutput(this, 'RuntimeArn', { value: this.runtimeArn });
  }

  public grantInvoke(grantee: IGrantable) {
    grantee.grantPrincipal.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ['bedrock-agentcore:InvokeAgentRuntime'],
        resources: [this.runtimeArn, `${this.runtimeArn}/runtime-endpoint/DEFAULT`],
      })
    );
  }
}

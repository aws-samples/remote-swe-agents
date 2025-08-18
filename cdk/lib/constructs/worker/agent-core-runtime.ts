import { PythonFunction } from '@aws-cdk/aws-lambda-python-alpha';
import { CfnOutput, CustomResource, Duration, Stack } from 'aws-cdk-lib';
import { ITableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { IRepository, Repository } from 'aws-cdk-lib/aws-ecr';
import { DockerImageAsset, Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { IGrantable, IPrincipal, ManagedPolicy, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { IBucket } from 'aws-cdk-lib/aws-s3';
import { IStringParameter } from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { ContainerImageBuild } from 'deploy-time-build';
import { readFileSync } from 'fs';
import { join } from 'path';
import { WorkerBus } from './bus';
import { DockerImageName, ECRDeployment } from 'cdk-ecr-deployment';

export interface AgentCoreRuntimeProps {
  repository: IRepository;
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
}

export class AgentCoreRuntime extends Construct implements IGrantable {
  public grantPrincipal: IPrincipal;
  public runtimeArn: string;

  constructor(scope: Construct, id: string, props: AgentCoreRuntimeProps) {
    super(scope, id);

    const repository = props.repository;

    const crHandler = new PythonFunction(this, 'CustomResourceHandler', {
      runtime: Runtime.PYTHON_3_13,
      timeout: Duration.seconds(10),
      entry: join(__dirname, 'resources', 'agent-core-runtime-cr'),
    });
    crHandler.role!.addToPrincipalPolicy(
      new PolicyStatement({
        actions: [
          'bedrock-agentcore:ListAgentRuntimes',
          'bedrock-agentcore:CreateAgentRuntime',
          'bedrock-agentcore:UpdateAgentRuntime',
          'bedrock-agentcore:DeleteAgentRuntime',
          'iam:PassRole',
        ],
        resources: ['*'],
      })
    );
    crHandler.role?.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName('BedrockAgentCoreFullAccess'));

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
    const deployDest = new DockerImageName(`${repository.repositoryUri}:${image.imageTag}`);
    const deploy = new ECRDeployment(this, 'ImageDeploy', {
      src: new DockerImageName(image.imageUri),
      dest: deployDest,
      imageArch: ['arm64'],
    });

    role.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'],
        resources: [`${repository.repositoryArn}`],
      })
    );
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

    const resource = new CustomResource(this, 'Resource', {
      serviceToken: crHandler.functionArn,
      resourceType: 'Custom::AgentCoreRuntime',
      properties: {
        ContainerUri: `${repository.repositoryUri}:${image.imageTag}`,
        RoleArn: role.roleArn,
        ServerProtocol: 'HTTP',
        Env: {
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
        },
      },
      serviceTimeout: Duration.seconds(20),
    });
    resource.node.addDependency(deploy.node.findChild('CustomResource'));

    this.runtimeArn = resource.getAttString('agentRuntimeArn');
    new CfnOutput(this, 'RuntimeArn', { value: this.runtimeArn });
  }
}

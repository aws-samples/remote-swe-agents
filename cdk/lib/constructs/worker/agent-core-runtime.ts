import { PythonFunction } from '@aws-cdk/aws-lambda-python-alpha';
import { CustomResource, Duration } from 'aws-cdk-lib';
import { Repository } from 'aws-cdk-lib/aws-ecr';
import { DockerImageAsset, Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { IGrantable, IPrincipal, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Code, Runtime, SingletonFunction } from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { ContainerImageBuild } from 'deploy-time-build';
import { readFileSync } from 'fs';
import { join } from 'path';

export interface AgentCoreRuntimeProps {}

export class AgentCoreRuntime extends Construct implements IGrantable {
  public grantPrincipal: IPrincipal;

  constructor(scope: Construct, id: string, props: AgentCoreRuntimeProps) {
    super(scope, id);

    const repository = Repository.fromRepositoryArn(
      this,
      'Repository',
      'arn:aws:ecr:us-east-1:198634196645:repository/import-test-repository'
    );

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

    const role = new Role(this, 'Role', {
      assumedBy: ServicePrincipal.fromStaticServicePrincipleName('bedrock-agentcore.amazonaws.com'),
    });
    this.grantPrincipal = role;

    const image = new ContainerImageBuild(this, 'WorkerImage', {
      directory: '..',
      file: join('docker', 'agent.Dockerfile'),
      exclude: readFileSync('.dockerignore').toString().split('\n'),
      platform: Platform.LINUX_ARM64,
      repository,
    });
    role.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'],
        resources: [`${image.repository.repositoryArn}`],
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
          'bedrock-agentcore:GetWorkloadAccessToken',
          'bedrock-agentcore:GetWorkloadAccessTokenForJWT',
          'bedrock-agentcore:GetWorkloadAccessTokenForUserId',
        ],
        resources: ['*'],
      })
    );

    const resource = new CustomResource(this, 'Resource', {
      serviceToken: crHandler.functionArn,
      resourceType: 'Custom::AgentCoreRuntime',
      properties: {
        ContainerUri: `${repository.repositoryUri}:${image.imageTag}`,
        RoleArn: role.roleArn,
        ServerProtocol: 'HTTP',
        Env: {},
      },
      serviceTimeout: Duration.seconds(20),
    });
  }
}

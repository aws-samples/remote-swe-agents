import { CfnOutput, CfnResource, CustomResource, Duration, Stack } from 'aws-cdk-lib';
import { IVpc, SecurityGroup } from 'aws-cdk-lib/aws-ec2';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { ImagePipeline, ImagePipelineProps } from 'cdk-image-pipeline';
import { Construct } from 'constructs';
import { readFileSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import * as yaml from 'yaml';
import { Code, Runtime, SingletonFunction } from 'aws-cdk-lib/aws-lambda';
import { CfnImageRecipe } from 'aws-cdk-lib/aws-imagebuilder';
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from 'aws-cdk-lib/custom-resources';
import { IBucket } from 'aws-cdk-lib/aws-s3';
import { ManagedPolicy } from 'aws-cdk-lib/aws-iam';

export interface WorkerImageBuilderProps {
  vpc: IVpc;
  installDependenciesCommand: string;
  amiIdParameterName: string;
  sourceBucket: IBucket;
  sourceAssetHash: string;
}

export class WorkerImageBuilder extends Construct {
  public readonly imageRecipeName: string;

  constructor(scope: Construct, id: string, props: WorkerImageBuilderProps) {
    super(scope, id);

    const { vpc, installDependenciesCommand, sourceBucket, sourceAssetHash } = props;

    const componentTemplateString = readFileSync(
      join(__dirname, 'resources', 'image-component-template.yml')
    ).toString();
    const componentTemplate = yaml.parse(componentTemplateString);

    componentTemplate.phases[0].steps[1].inputs.commands = [installDependenciesCommand];
    const componentYamlPath = join(__dirname, 'resources', `${Stack.of(this).stackName}-image-component.yml`);
    writeFileSync(componentYamlPath, yaml.stringify(componentTemplate, { lineWidth: 0 }));

    const versioningHandler = new SingletonFunction(this, 'ImageBuilderVersioningHandler', {
      runtime: Runtime.NODEJS_22_X,
      handler: 'index.handler',
      timeout: Duration.seconds(5),
      lambdaPurpose: 'ImageBuilderVersioning',
      uuid: '153e8b47-ce27-4abc-a3b1-ad890c5d81e4',
      code: Code.fromInline(readFileSync(join(__dirname, 'resources', 'versioning-handler.js')).toString()),
    });

    const securityGroup = new SecurityGroup(this, 'SecurityGroup', { vpc });

    const componentVersion = new CustomResource(this, 'WorkerDependenciesVersion', {
      serviceToken: versioningHandler.functionArn,
      resourceType: 'Custom::ImageBuilderVersioning',
      properties: { initialVersion: '0.0.0', key: yaml.stringify(componentTemplate, { lineWidth: 0 }) },
      serviceTimeout: Duration.seconds(20),
    });

    const imagePipelineProps: Omit<ImagePipelineProps, 'imageRecipeVersion' | 'components'> = {
      parentImage: StringParameter.fromStringParameterAttributes(this, 'ParentImageId', {
        parameterName: '/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id',
        forceDynamicReference: true,
      }).stringValue,
      subnetId: vpc.publicSubnets[0].subnetId,
      securityGroups: [securityGroup.securityGroupId],
      amiIdSsmPath: props.amiIdParameterName,
      amiIdSsmAccountId: Stack.of(this).account,
      amiIdSsmRegion: Stack.of(this).region,
      ebsVolumeConfigurations: [
        {
          deviceName: '/dev/sda1',
          ebs: {
            encrypted: true,
            volumeSize: 30,
            volumeType: 'gp3',
          },
        },
      ],
    };

    const recipeVersion = new CustomResource(this, 'ImageRecipeVersion', {
      serviceToken: versioningHandler.functionArn,
      resourceType: 'Custom::ImageBuilderVersioning',
      properties: {
        initialVersion: '0.0.0',
        key: JSON.stringify({
          ...imagePipelineProps,
          componentsVersion: componentVersion.getAttString('version'),
          sourceAssetHash: `worker-asset-hash:${sourceAssetHash}`,
        }),
      },
      serviceTimeout: Duration.seconds(20),
    });

    const additionalInstancePolicy = new ManagedPolicy(this, 'AdditionalInstancePolicy');
    sourceBucket.grantRead(additionalInstancePolicy);

    const pipeline = new ImagePipeline(this, 'ImagePipelineV2', {
      ...imagePipelineProps,
      components: [
        {
          document: relative(process.cwd(), componentYamlPath),
          name: 'WorkerDependencies',
          version: componentVersion.getAttString('version'),
        },
      ],
      imageRecipeVersion: recipeVersion.getAttString('version'),
      additionalPolicies: [additionalInstancePolicy],
    });

    // avoid duplicated SSM state association
    const cfnPipeline = pipeline.node.findChild('ImagePipeline') as CfnResource;
    cfnPipeline.addPropertyOverride('EnhancedImageMetadataEnabled', false);
    this.imageRecipeName = (pipeline.node.findChild('ImageRecipe') as CfnImageRecipe).attrName;

    // change this physical id manually when you want to force users to remove the AMI cache
    // (e.g. when DynamoDB table ARN changed)
    const amiVersion = 'v4';
    // Run the build pipeline asynchronously
    new AwsCustomResource(this, 'RunPipeline', {
      onUpdate: {
        service: '@aws-sdk/client-imagebuilder',
        action: 'StartImagePipelineExecution',
        parameters: {
          imagePipelineArn: pipeline.pipeline.attrArn,
        },
        physicalResourceId: PhysicalResourceId.of(`${recipeVersion.getAttString('version')}#${amiVersion}`),
      },
      policy: AwsCustomResourcePolicy.fromSdkCalls({
        resources: [pipeline.pipeline.attrArn],
      }),
    });

    new AwsCustomResource(this, 'PurgeAmiCache', {
      onUpdate: {
        service: '@aws-sdk/client-ssm',
        action: 'DeleteParameter',
        parameters: {
          Name: props.amiIdParameterName,
        },
        ignoreErrorCodesMatching: 'ParameterNotFound',
        physicalResourceId: PhysicalResourceId.of(`${amiVersion}`),
      },
      policy: AwsCustomResourcePolicy.fromSdkCalls({
        resources: [
          StringParameter.fromStringParameterAttributes(this, 'AmiIdParameter', {
            parameterName: props.amiIdParameterName,
            forceDynamicReference: true,
          }).parameterArn,
        ],
      }),
    });

    new CfnOutput(this, 'RemoveCachedAmiCommand', {
      value: `aws ssm delete-parameter --name ${props.amiIdParameterName} --region ${Stack.of(this).region}`,
    });
  }
}

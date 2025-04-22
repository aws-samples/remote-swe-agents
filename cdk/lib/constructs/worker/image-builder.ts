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

export interface WorkerImageBuilderProps {
  vpc: IVpc;
  installDependenciesCommand: string;
  amiIdParameterName: string;
}

export class WorkerImageBuilder extends Construct {
  public readonly imageRecipeName: string;

  constructor(scope: Construct, id: string, props: WorkerImageBuilderProps) {
    super(scope, id);

    const { vpc, installDependenciesCommand } = props;

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
            volumeSize: 50,
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
        key: JSON.stringify({ ...imagePipelineProps, componentsVersion: componentVersion.getAttString('version') }),
      },
      serviceTimeout: Duration.seconds(20),
    });

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
    });

    // avoid duplicated SSM state association
    (pipeline.node.findChild('ImagePipeline') as CfnResource).addPropertyOverride(
      'EnhancedImageMetadataEnabled',
      false
    );
    this.imageRecipeName = (pipeline.node.findChild('ImageRecipe') as CfnImageRecipe).attrName;

    // Run the build pipeline asynchronously
    new AwsCustomResource(this, 'RunPipeline', {
      onUpdate: {
        service: '@aws-sdk/client-imagebuilder',
        action: 'StartImagePipelineExecution',
        parameters: {
          imagePipelineArn: pipeline.pipeline.attrArn,
        },
        physicalResourceId: PhysicalResourceId.of(recipeVersion.getAttString('version')),
      },
      policy: AwsCustomResourcePolicy.fromSdkCalls({
        resources: [pipeline.pipeline.attrArn],
      }),
    });

    new CfnOutput(this, 'RemoveCachedAmiCommand', {
      value: `aws ssm delete-parameter --name ${props.amiIdParameterName} --region ${Stack.of(this).region}`,
    });
  }
}

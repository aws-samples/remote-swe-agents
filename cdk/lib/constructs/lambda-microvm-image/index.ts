import { Arn, ArnFormat, Names, RemovalPolicy, Size, Stack } from 'aws-cdk-lib';
import { CfnMicrovmImage } from 'aws-cdk-lib/aws-lambda';
import { Grant, IGrantable, IRole, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { BucketGrants, IBucketRef } from 'aws-cdk-lib/aws-s3';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import { Construct } from 'constructs';

// ---------------------------------------------------------------------------
// Code
// ---------------------------------------------------------------------------

interface MicrovmCodeBindResult {
  readonly uri: string;
}

/**
 * Represents the code artifact for a Lambda MicroVM image.
 * Use static factory methods to create instances.
 */
export abstract class MicrovmCode {
  /**
   * Create code from a Docker build context directory.
   * The directory must contain a Dockerfile. It will be zipped and uploaded
   * as an S3 asset during CDK synthesis.
   */
  static fromDockerBuild(directory: string): MicrovmCode {
    return new DockerBuildCode(directory);
  }

  /**
   * Create code from an existing S3 object (pre-built zip artifact).
   */
  static fromBucket(bucket: IBucketRef, key: string, objectVersion?: string): MicrovmCode {
    return new S3Code(bucket, key, objectVersion);
  }

  /** @internal */
  abstract bind(scope: Construct, buildRole: IRole): MicrovmCodeBindResult;
}

class DockerBuildCode extends MicrovmCode {
  constructor(private readonly directory: string) {
    super();
  }

  bind(scope: Construct, buildRole: IRole): MicrovmCodeBindResult {
    const asset = new Asset(scope, 'Code', { path: this.directory });
    asset.grantRead(buildRole);
    return { uri: asset.s3ObjectUrl };
  }
}

class S3Code extends MicrovmCode {
  constructor(
    private readonly bucket: IBucketRef,
    private readonly key: string,
    private readonly objectVersion?: string
  ) {
    super();
  }

  bind(_scope: Construct, buildRole: IRole): MicrovmCodeBindResult {
    BucketGrants.fromBucket(this.bucket).read(buildRole, this.key);
    const bucketName = this.bucket.bucketRef.bucketName;
    const uri = this.objectVersion
      ? `s3://${bucketName}/${this.key}?versionId=${this.objectVersion}`
      : `s3://${bucketName}/${this.key}`;
    return { uri };
  }
}

// ---------------------------------------------------------------------------
// Base image
// ---------------------------------------------------------------------------

/**
 * Represents a Lambda MicroVM base image.
 * Use static properties to select a base image version.
 */
export class MicrovmBaseImage {
  /** Amazon Linux 2023, version 1. */
  static readonly AL2023_1 = new MicrovmBaseImage('al2023-1', '1');

  private constructor(
    private readonly imageName: string,
    private readonly version: string
  ) {}

  /** @internal */
  public bind(scope: Construct): { baseImageArn: string; baseImageVersion: string } {
    return {
      baseImageArn: Arn.format(
        {
          service: 'lambda',
          account: 'aws',
          resource: 'microvm-image',
          resourceName: this.imageName,
          arnFormat: ArnFormat.COLON_RESOURCE_NAME,
        },
        Stack.of(scope)
      ),
      baseImageVersion: this.version,
    };
  }
}

// ---------------------------------------------------------------------------
// Architecture
// ---------------------------------------------------------------------------

/** CPU architecture for the MicroVM image. */
export enum MicrovmArchitecture {
  ARM_64 = 'ARM_64',
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

/**
 * Collection of grant methods for a LambdaMicrovmImage.
 * Follows the BucketGrants pattern.
 */
export class MicrovmImageGrants {
  /** @internal */
  static fromMicrovmImage(image: LambdaMicrovmImage): MicrovmImageGrants {
    return new MicrovmImageGrants(image);
  }

  private constructor(private readonly image: LambdaMicrovmImage) {}

  /**
   * Grant permission to run MicroVMs from this image.
   */
  read(grantee: IGrantable): Grant {
    return Grant.addToPrincipal({
      grantee,
      actions: ['lambda-microvms:RunMicrovm'],
      resourceArns: [this.image.imageArn],
    });
  }
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface LambdaMicrovmImageProps {
  /**
   * The code artifact for the MicroVM image.
   * Use MicrovmCode.fromDockerBuild() or MicrovmCode.fromBucket().
   */
  readonly code: MicrovmCode;

  /** The base MicroVM image to build upon. */
  readonly baseImage: MicrovmBaseImage;

  /** CPU architecture for the MicroVM. */
  readonly architecture: MicrovmArchitecture;

  /**
   * Memory allocated to the MicroVM.
   *
   * @default Size.mebibytes(512)
   */
  readonly memorySize?: Size;

  /**
   * Human-readable description of this MicroVM image.
   *
   * @default - auto-generated from stack and construct names
   */
  readonly description?: string;

  /**
   * Environment variables injected into the MicroVM at runtime.
   *
   * @default - none
   */
  readonly environment?: Record<string, string>;

  /**
   * Removal policy for the MicroVM image resource.
   *
   * @default RemovalPolicy.DESTROY
   */
  readonly removalPolicy?: RemovalPolicy;
}

// ---------------------------------------------------------------------------
// Construct
// ---------------------------------------------------------------------------

/**
 * Creates a Lambda MicroVM image from a code artifact and base image.
 *
 * The image is built asynchronously by the Lambda MicroVMs service.
 * CloudFormation waits for the image to reach CREATED state before proceeding.
 */
export class LambdaMicrovmImage extends Construct {
  /** The ARN of the MicroVM image (resolved after deployment). */
  public readonly imageArn: string;

  /** The IAM role used during the image build process. */
  public readonly buildRole: IRole;

  /** Collection of grant methods for this image. */
  get grants(): MicrovmImageGrants {
    return MicrovmImageGrants.fromMicrovmImage(this);
  }

  constructor(scope: Construct, id: string, props: LambdaMicrovmImageProps) {
    super(scope, id);

    const stack = Stack.of(this);
    const baseImage = props.baseImage.bind(this);
    const memoryMiB = (props.memorySize ?? Size.mebibytes(512)).toMebibytes();

    const buildRole = new Role(this, 'BuildRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });
    this.buildRole = buildRole;

    const codeConfig = props.code.bind(this, buildRole);

    // Name constraint: ^[a-zA-Z0-9-_]+$, maxLength 64 (per AWS::Lambda::MicrovmImage CFn schema).
    const imageName = Names.uniqueResourceName(this, { maxLength: 64, separator: '-' });

    const envVars: CfnMicrovmImage.EnvironmentVariableProperty[] = Object.entries(props.environment ?? {}).map(
      ([key, value]) => ({ key, value })
    );

    const resource = new CfnMicrovmImage(this, 'Resource', {
      name: imageName,
      baseImageArn: baseImage.baseImageArn,
      baseImageVersion: baseImage.baseImageVersion,
      buildRoleArn: buildRole.roleArn,
      description: props.description ?? `MicroVM image for ${stack.stackName}/${id}`,
      codeArtifact: { uri: codeConfig.uri },
      logging: { disabled: true },
      egressNetworkConnectors: [],
      cpuConfigurations: [{ architecture: props.architecture }],
      resources: [{ minimumMemoryInMiB: memoryMiB }],
      additionalOsCapabilities: [],
      hooks: {},
      environmentVariables: envVars,
    });

    resource.applyRemovalPolicy(props.removalPolicy ?? RemovalPolicy.DESTROY);
    this.imageArn = resource.attrImageArn;
  }
}

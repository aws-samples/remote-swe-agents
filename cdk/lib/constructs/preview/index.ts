import { Arn, ArnFormat, CfnOutput, RemovalPolicy, Size, Stack } from 'aws-cdk-lib';
import {
  CachePolicy,
  Distribution,
  HttpVersion,
  OriginProtocolPolicy,
  OriginRequestPolicy,
  ViewerProtocolPolicy,
  LambdaEdgeEventType,
  AllowedMethods,
  OriginRequestCookieBehavior,
  OriginRequestHeaderBehavior,
  OriginRequestQueryStringBehavior,
} from 'aws-cdk-lib/aws-cloudfront';
import { HttpOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { ITableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { IBucket } from 'aws-cdk-lib/aws-s3';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { EdgeFunction } from '../cf-lambda-furl-service/edge-function';
import { AwsCustomResourcePolicy, PhysicalResourceId, AwsCustomResource } from 'aws-cdk-lib/custom-resources';
import { LambdaMicrovmImage, MicrovmArchitecture, MicrovmBaseImage, MicrovmCode } from '../lambda-microvm-image';

export interface PreviewProps {
  storageTable: ITableV2;
  accessLogBucket: IBucket;
  originRequestHandler: EdgeFunction;
  /**
   * SSM parameter name in us-east-1 for storing preview config.
   * The L@E reads this at cold start.
   */
  configParameterName: string;
  /**
   * Path to the MicroVM preview proxy source directory.
   * The image is built and managed automatically during deployment.
   */
  proxyCodeDirectory: string;
  webAclArn?: string;
}

export class Preview extends Construct {
  public readonly distributionDomainName: string;
  public readonly previewUrl: string;
  public readonly handoffSecretArn: string;
  public readonly microvmImageArn: string;

  constructor(scope: Construct, id: string, props: PreviewProps) {
    super(scope, id);

    const image = new LambdaMicrovmImage(this, 'Image', {
      code: MicrovmCode.fromDockerBuild(props.proxyCodeDirectory),
      baseImage: MicrovmBaseImage.AL2023_1,
      architecture: MicrovmArchitecture.ARM_64,
      memorySize: Size.gibibytes(8),
    });
    this.microvmImageArn = image.imageArn;

    // R-B: Server-side generated secret in Secrets Manager (never in CFn template)
    const handoffSecret = new Secret(this, 'HandoffSecret', {
      secretName: `${Stack.of(this).stackName}-PreviewHandoffSecret`,
      description: 'HMAC secret for preview handoff token signing',
      generateSecretString: {
        excludePunctuation: true,
        passwordLength: 64,
      },
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.handoffSecretArn = handoffSecret.secretArn;

    // Write config to SSM parameter in us-east-1 so L@E can read at cold start.
    // The secret ARN is stored (not the value) — L@E fetches the value from Secrets Manager.
    const configValue = JSON.stringify({
      tableName: props.storageTable.tableName,
      mainRegion: Stack.of(this).region,
      handoffSecretArn: handoffSecret.secretArn,
    });

    new AwsCustomResource(this, 'WriteConfigToUsEast1', {
      onUpdate: {
        service: 'SSM',
        action: 'putParameter',
        parameters: {
          Name: props.configParameterName,
          Value: configValue,
          Type: 'String',
          Overwrite: true,
        },
        region: 'us-east-1',
        physicalResourceId: PhysicalResourceId.of(props.configParameterName),
      },
      onDelete: {
        service: 'SSM',
        action: 'deleteParameter',
        parameters: {
          Name: props.configParameterName,
        },
        region: 'us-east-1',
      },
      policy: AwsCustomResourcePolicy.fromStatements([
        new PolicyStatement({
          actions: ['ssm:PutParameter', 'ssm:DeleteParameter'],
          resources: [
            Arn.format(
              {
                service: 'ssm',
                resource: 'parameter',
                resourceName: props.configParameterName.replace(/^\//, ''),
                arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
                region: 'us-east-1',
              },
              Stack.of(this)
            ),
          ],
        }),
      ]),
    });

    // Grant L@E role permission to read the SSM parameter (us-east-1)
    props.originRequestHandler.role.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [
          Arn.format(
            {
              service: 'ssm',
              resource: 'parameter',
              resourceName: props.configParameterName.replace(/^\//, ''),
              arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
              region: 'us-east-1',
            },
            Stack.of(this)
          ),
        ],
      })
    );

    // Grant L@E role permission to read the handoff secret from Secrets Manager
    // Use a constructed ARN pattern to avoid cross-stack reference (UsEast1Stack → MainStack)
    // The L@E discovers the actual secret ARN from the SSM config parameter at runtime.
    const secretArnPattern = Arn.format(
      {
        service: 'secretsmanager',
        resource: 'secret',
        resourceName: `${Stack.of(this).stackName}*`,
        arnFormat: ArnFormat.COLON_RESOURCE_NAME,
      },
      Stack.of(this)
    );
    props.originRequestHandler.role.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [secretArnPattern],
      })
    );

    // Grant L@E role DDB read access for preview token lookup (cross-region, R2)
    // Use a constructed ARN pattern to avoid cross-stack reference (UsEast1Stack → MainStack)
    const tableArnPattern = Arn.format(
      {
        service: 'dynamodb',
        resource: 'table',
        resourceName: `${Stack.of(this).stackName}*`,
        arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
      },
      Stack.of(this)
    );
    props.originRequestHandler.role.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ['dynamodb:GetItem'],
        resources: [tableArnPattern],
      })
    );

    // Dummy origin - will be overridden by L@E origin-request
    const dummyOrigin = new HttpOrigin('example.com', {
      protocolPolicy: OriginProtocolPolicy.HTTPS_ONLY,
    });

    // No caching for preview (dev servers serve dynamic content)
    // Use the managed CachingDisabled policy — custom TTL=0 policies cannot
    // specify cookie/header/query behaviors per CloudFront validation rules.
    // Cookie/header/query forwarding to origin is handled by the origin request policy.

    // Forward necessary headers to origin
    const originRequestPolicy = new OriginRequestPolicy(this, 'OriginRequestPolicy', {
      originRequestPolicyName: `${Stack.of(this).stackName}-PreviewOriginRequest`,
      cookieBehavior: OriginRequestCookieBehavior.all(),
      headerBehavior: OriginRequestHeaderBehavior.allowList(
        'Accept',
        'Accept-Language',
        'Content-Type',
        'Referer',
        'Origin',
        'Sec-WebSocket-Key',
        'Sec-WebSocket-Version',
        'Sec-WebSocket-Protocol',
        'Sec-WebSocket-Extensions'
      ),
      queryStringBehavior: OriginRequestQueryStringBehavior.all(),
    });

    const distribution = new Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: dummyOrigin,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_ALL,
        cachePolicy: CachePolicy.CACHING_DISABLED,
        originRequestPolicy,
        edgeLambdas: [
          {
            eventType: LambdaEdgeEventType.ORIGIN_REQUEST,
            functionVersion: props.originRequestHandler.versionArn(this),
            includeBody: true,
          },
        ],
      },
      httpVersion: HttpVersion.HTTP2_AND_3,
      logBucket: props.accessLogBucket,
      logFilePrefix: 'cf-preview/',
      ...(props.webAclArn ? { webAclId: props.webAclArn } : {}),
    });

    this.distributionDomainName = distribution.distributionDomainName;
    this.previewUrl = `https://${distribution.distributionDomainName}`;

    new CfnOutput(this, 'PreviewDomainName', {
      value: this.previewUrl,
    });

    new CfnOutput(this, 'PreviewDistributionDomain', {
      value: distribution.distributionDomainName,
    });
  }
}

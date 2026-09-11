import { CfnOutput, Duration, RemovalPolicy } from 'aws-cdk-lib';
import { AttributeType, Billing, TableV2, ProjectionType } from 'aws-cdk-lib/aws-dynamodb';
import { BlockPublicAccess, Bucket, HttpMethods, IBucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface StorageProps {
  accessLogBucket: IBucket;
}

export class Storage extends Construct {
  public readonly table: TableV2;
  public readonly bucket: Bucket;
  public readonly skillBucket: Bucket;

  constructor(scope: Construct, id: string, props: StorageProps) {
    super(scope, id);

    const table = new TableV2(this, 'History', {
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
      billing: Billing.onDemand(),
      timeToLiveAttribute: 'TTL',
      removalPolicy: RemovalPolicy.DESTROY,
      localSecondaryIndexes: [
        {
          indexName: 'LSI1',
          sortKey: { name: 'LSI1', type: AttributeType.STRING },
          projectionType: ProjectionType.ALL,
        },
      ],
      globalSecondaryIndexes: [
        {
          indexName: 'GSI1',
          partitionKey: { name: 'SK', type: AttributeType.STRING },
          sortKey: { name: 'PK', type: AttributeType.STRING },
          projectionType: ProjectionType.KEYS_ONLY,
        },
      ],
    });

    const bucket = new Bucket(this, 'ImageBucket', {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      enforceSSL: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      serverAccessLogsBucket: props.accessLogBucket,
      serverAccessLogsPrefix: 's3AccessLog/ImageBucket/',
      cors: [
        {
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
          allowedMethods: [HttpMethods.GET, HttpMethods.HEAD, HttpMethods.PUT, HttpMethods.POST],
          maxAge: 3000,
        },
      ],
    });

    // Dedicated bucket for skill packages. Non-prod defaults to DESTROY +
    // autoDeleteObjects; production stacks override to RETAIN via
    // RemovalPolicies.of(stack).retain() in bin/cdk.ts.
    const skillBucket = new Bucket(this, 'SkillBucket', {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      enforceSSL: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      lifecycleRules: [
        {
          noncurrentVersionExpiration: Duration.days(90),
        },
      ],
      serverAccessLogsBucket: props.accessLogBucket,
      serverAccessLogsPrefix: 's3AccessLog/SkillBucket/',
      cors: [
        {
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
          allowedMethods: [HttpMethods.GET, HttpMethods.HEAD, HttpMethods.PUT, HttpMethods.POST],
          maxAge: 3000,
        },
      ],
    });

    this.table = table;
    this.bucket = bucket;
    this.skillBucket = skillBucket;

    new CfnOutput(this, 'TableName', { value: table.tableName });
    new CfnOutput(this, 'BucketName', { value: bucket.bucketName });
    new CfnOutput(this, 'SkillBucketName', { value: skillBucket.bucketName });
  }
}

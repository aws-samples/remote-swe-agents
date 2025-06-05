import { CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import { AttributeType, Billing, TableV2, ProjectionType } from 'aws-cdk-lib/aws-dynamodb';
import { BlockPublicAccess, Bucket, HttpMethods, IBucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface StorageProps {
  accessLogBucket: IBucket;
}

export class Storage extends Construct {
  public readonly table: TableV2;
  public readonly bucket: Bucket;

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

    this.table = table;
    this.bucket = bucket;

    new CfnOutput(this, 'TableName', { value: table.tableName });
    new CfnOutput(this, 'BucketName', { value: bucket.bucketName });
  }
}

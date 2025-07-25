import { Construct } from 'constructs';
import { Duration } from 'aws-cdk-lib';
import { FunctionUrlAuthType, IFunction, InvokeMode } from 'aws-cdk-lib/aws-lambda';
import {
  AllowedMethods,
  CacheCookieBehavior,
  CacheHeaderBehavior,
  CachePolicy,
  CacheQueryStringBehavior,
  Distribution,
  LambdaEdgeEventType,
  OriginRequestPolicy,
  SecurityPolicyProtocol,
} from 'aws-cdk-lib/aws-cloudfront';
import { FunctionUrlOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { ARecord, IHostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { CloudFrontTarget } from 'aws-cdk-lib/aws-route53-targets';
import { ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { EdgeFunction } from './edge-function';

export interface CloudFrontLambdaFunctionUrlServiceProps {
  /**
   * @default use root domain
   */
  subDomain?: string;
  handler: IFunction;

  /**
   * This should be unique across the app
   */
  serviceName: string;

  /**
   * @default basic auth is disabled
   */
  basicAuthUsername?: string;
  basicAuthPassword?: string;

  hostedZone?: IHostedZone;
  certificate?: ICertificate;
  signPayloadHandler: EdgeFunction;
  /**
   * The ARN of the WAF Web ACL to associate with the CloudFront distribution
   * @default no WAF Web ACL
   */
  webAclArn?: string;
  accessLogBucket: Bucket;
}

export class CloudFrontLambdaFunctionUrlService extends Construct {
  public readonly urlParameter: StringParameter;
  public readonly url: string;
  public readonly domainName: string;

  constructor(scope: Construct, id: string, props: CloudFrontLambdaFunctionUrlServiceProps) {
    super(scope, id);
    const { handler, serviceName, subDomain, hostedZone, certificate, accessLogBucket, signPayloadHandler } = props;
    let domainName = '';
    if (hostedZone) {
      domainName = subDomain ? `${subDomain}.${hostedZone.zoneName}` : hostedZone.zoneName;
    }

    const furl = handler.addFunctionUrl({
      authType: FunctionUrlAuthType.AWS_IAM,
      invokeMode: InvokeMode.RESPONSE_STREAM,
    });
    const origin = FunctionUrlOrigin.withOriginAccessControl(furl, {
      connectionTimeout: Duration.seconds(6),
      readTimeout: Duration.seconds(60),
    });

    const defaultCachePolicy = new CachePolicy(this, 'DefaultCachePolicy', {
      queryStringBehavior: CacheQueryStringBehavior.all(),
      headerBehavior: CacheHeaderBehavior.allowList(
        // CachePolicy.USE_ORIGIN_CACHE_CONTROL_HEADERS_QUERY_STRINGS contains Host header here,
        // making it impossible to use with API Gateway
        'authorization',
        'Origin',
        'X-HTTP-Method-Override',
        'X-HTTP-Method',
        'X-Method-Override'
      ),
      defaultTtl: Duration.seconds(0),
      cookieBehavior: CacheCookieBehavior.all(),
      enableAcceptEncodingBrotli: true,
      enableAcceptEncodingGzip: true,
    });

    // this cache policy ignores authorization/cookie header,
    // which can be used for public cache routes.
    const staticCachePolicy = new CachePolicy(this, 'StaticCachePolicy', {
      queryStringBehavior: CacheQueryStringBehavior.all(),
      headerBehavior: CacheHeaderBehavior.allowList(
        // CachePolicy.USE_ORIGIN_CACHE_CONTROL_HEADERS_QUERY_STRINGS contains Host header here,
        // making it impossible to use with API Gateway
        'Origin',
        'X-HTTP-Method-Override',
        'X-HTTP-Method',
        'X-Method-Override'
      ),
      defaultTtl: Duration.seconds(0),
      enableAcceptEncodingBrotli: true,
      enableAcceptEncodingGzip: true,
    });

    const distribution = new Distribution(this, 'Resource', {
      comment: `CloudFront for ${serviceName}`,
      webAclId: props.webAclArn,
      defaultBehavior: {
        origin,
        cachePolicy: defaultCachePolicy,
        allowedMethods: AllowedMethods.ALLOW_ALL,
        originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        edgeLambdas: [
          {
            functionVersion: signPayloadHandler.versionArn(this),
            eventType: LambdaEdgeEventType.ORIGIN_REQUEST,
            includeBody: true,
          },
        ],
      },
      additionalBehaviors: {
        '_next/static/*': {
          origin,
          cachePolicy: staticCachePolicy,
          allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          // we won't need lambda@edge for GET/HEAD requests.
        },
      },
      logBucket: accessLogBucket,
      logFilePrefix: `${serviceName}/`,
      ...(hostedZone ? { certificate: certificate, domainNames: [domainName] } : {}),
      minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021,
    });

    if (hostedZone) {
      new ARecord(this, 'Record', {
        zone: hostedZone,
        target: RecordTarget.fromAlias(new CloudFrontTarget(distribution)),
        recordName: subDomain,
      });
    } else {
      domainName = distribution.domainName;
    }

    this.url = `https://${domainName}`;
    this.domainName = domainName;
  }
}

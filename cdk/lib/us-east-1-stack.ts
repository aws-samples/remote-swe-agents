import * as cdk from 'aws-cdk-lib';
import { Certificate, CertificateValidation, ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import { ARecord, HostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';
import { EdgeFunction } from './constructs/cf-lambda-furl-service/edge-function';
import { CommonWebAcl } from './constructs/web-acl';
import { join } from 'path';

interface UsEast1StackProps extends cdk.StackProps {
  domainName?: string;
  allowedIpV4AddressRanges?: string[];
  allowedIpV6AddressRanges?: string[];
  allowedCountryCodes?: string[];
  previewConfigParameterName?: string;
}

export class UsEast1Stack extends cdk.Stack {
  /**
   * the ACM certificate for CloudFront (it must be deployed in us-east-1).
   * undefined if domainName is not set.
   */
  public readonly certificate: ICertificate | undefined = undefined;
  /**
   * the signer L@E function (it must be deployed in us-east-1).
   */
  public readonly signPayloadHandler: EdgeFunction;
  /**
   * the preview origin-request L@E function (it must be deployed in us-east-1).
   */
  public readonly previewOriginRequestHandler: EdgeFunction;
  /**
   * the WAF Web ACL ARN for CloudFront (it must be deployed in us-east-1).
   * undefined if no IP restrictions are set.
   */
  public readonly webAclArn: string | undefined = undefined;

  /**
   * SSM parameter name in us-east-1 for preview config.
   */
  public readonly previewConfigParameterName: string;

  constructor(scope: Construct, id: string, props: UsEast1StackProps) {
    super(scope, id, props);

    this.previewConfigParameterName = props.previewConfigParameterName || `/${this.stackName}/preview-config`;

    if (props.domainName) {
      const hostedZone = HostedZone.fromLookup(this, 'HostedZone', {
        domainName: props.domainName,
      });

      // cognito requires A record for Hosted UI custom domain
      // https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-add-custom-domain.html#cognito-user-pools-add-custom-domain-adding
      // > Its parent domain must have a valid DNS A record. You can assign any value to this record.
      new ARecord(this, 'Record', {
        zone: hostedZone,
        target: RecordTarget.fromIpAddresses('8.8.8.8'),
      });

      const cert = new Certificate(this, 'CertificateV2', {
        domainName: `*.${hostedZone.zoneName}`,
        validation: CertificateValidation.fromDns(hostedZone),
        subjectAlternativeNames: [hostedZone.zoneName],
      });
      this.certificate = cert;
    }

    const signPayloadHandler = new EdgeFunction(this, 'SignPayloadHandler', {
      entryPath: join(__dirname, 'constructs', 'cf-lambda-furl-service', 'lambda', 'sign-payload.ts'),
    });

    this.signPayloadHandler = signPayloadHandler;

    const previewOriginRequestHandler = new EdgeFunction(this, 'PreviewOriginRequestHandler', {
      entryPath: join(__dirname, 'constructs', 'preview', 'lambda', 'origin-request.ts'),
      bundlingDefine: {
        'process.env.__PREVIEW_CONFIG_PARAM__': JSON.stringify(this.previewConfigParameterName),
      },
    });

    this.previewOriginRequestHandler = previewOriginRequestHandler;

    if (props.allowedIpV4AddressRanges || props.allowedIpV6AddressRanges || props.allowedCountryCodes) {
      const webAcl = new CommonWebAcl(this, 'WebAcl', {
        scope: 'CLOUDFRONT',
        allowedIpV4AddressRanges: props.allowedIpV4AddressRanges,
        allowedIpV6AddressRanges: props.allowedIpV6AddressRanges,
        allowedCountryCodes: props.allowedCountryCodes,
      });

      this.webAclArn = webAcl.webAclArn;
    }
  }
}

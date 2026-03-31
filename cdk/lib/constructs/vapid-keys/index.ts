import { Construct } from 'constructs';
import { CustomResource, Duration, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Runtime, Code, SingletonFunction } from 'aws-cdk-lib/aws-lambda';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { IGrantable } from 'aws-cdk-lib/aws-iam';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';

export class VapidKeys extends Construct {
  public readonly publicKeyParameter: StringParameter;
  public readonly privateKeyParameter: StringParameter;
  public readonly customResource: CustomResource;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.publicKeyParameter = new StringParameter(this, 'PublicKey', {
      stringValue: 'pending-generation',
    });

    this.privateKeyParameter = new StringParameter(this, 'PrivateKey', {
      stringValue: 'pending-generation',
    });

    const handler = new SingletonFunction(this, 'Handler', {
      uuid: 'vapid-key-generator-singleton',
      runtime: Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: Code.fromInline(`
const { SSMClient, GetParameterCommand, PutParameterCommand } = require('@aws-sdk/client-ssm');
const crypto = require('crypto');

exports.handler = async (event) => {
  const ssm = new SSMClient({});
  const publicKeyParamName = event.ResourceProperties.PublicKeyParameterName;
  const privateKeyParamName = event.ResourceProperties.PrivateKeyParameterName;

  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: event.PhysicalResourceId || 'vapid-keys' };
  }

  // Check if keys already exist (value other than the initial placeholder)
  try {
    const existing = await ssm.send(new GetParameterCommand({ Name: publicKeyParamName }));
    if (existing.Parameter.Value !== 'pending-generation') {
      console.log('VAPID keys already exist, skipping generation');
      return { PhysicalResourceId: 'vapid-keys' };
    }
  } catch (e) {
    // Parameter doesn't exist or error, proceed to generate
  }

  // Generate VAPID keys using Web Crypto
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );

  const privateKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);

  // Convert to URL-safe base64 format expected by web-push
  const rawPublicKey = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  const publicKeyUrlSafe = Buffer.from(rawPublicKey).toString('base64url');

  const privateKeyUrlSafe = privateKeyJwk.d;

  await ssm.send(new PutParameterCommand({
    Name: publicKeyParamName,
    Value: publicKeyUrlSafe,
    Type: 'String',
    Overwrite: true,
  }));

  await ssm.send(new PutParameterCommand({
    Name: privateKeyParamName,
    Value: privateKeyUrlSafe,
    Type: 'String',
    Overwrite: true,
  }));

  console.log('VAPID keys generated and stored');
  return { PhysicalResourceId: 'vapid-keys' };
};
      `),
      timeout: Duration.minutes(1),
    });

    this.publicKeyParameter.grantWrite(handler);
    this.privateKeyParameter.grantWrite(handler);
    this.publicKeyParameter.grantRead(handler);
    this.privateKeyParameter.grantRead(handler);

    const provider = new Provider(this, 'Provider', {
      onEventHandler: handler,
    });

    this.customResource = new CustomResource(this, 'Resource', {
      serviceToken: provider.serviceToken,
      properties: {
        PublicKeyParameterName: this.publicKeyParameter.parameterName,
        PrivateKeyParameterName: this.privateKeyParameter.parameterName,
        ForceRegenerate: 'v2',
      },
    });
  }

  grantRead(grantee: IGrantable): void {
    this.publicKeyParameter.grantRead(grantee);
    this.privateKeyParameter.grantRead(grantee);
  }
}

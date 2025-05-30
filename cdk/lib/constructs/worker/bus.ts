import { Construct } from 'constructs';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import { CfnResource, Names, Stack } from 'aws-cdk-lib';
import { IUserPool } from 'aws-cdk-lib/aws-cognito';
import { join } from 'path';

export interface WorkerBusProps {}

export class WorkerBus extends Construct {
  public readonly httpEndpoint: string;
  public readonly api: appsync.EventApi;

  private userPoolCount = 0;
  constructor(scope: Construct, id: string, props: WorkerBusProps) {
    super(scope, id);

    const iamProvider: appsync.AppSyncAuthProvider = {
      authorizationType: appsync.AppSyncAuthorizationType.IAM,
    };

    const api = new appsync.EventApi(this, 'Api', {
      apiName: Names.uniqueResourceName(this, { maxLength: 30 }),
      authorizationConfig: {
        authProviders: [iamProvider],
        connectionAuthModeTypes: [appsync.AppSyncAuthorizationType.IAM],
        defaultPublishAuthModeTypes: [appsync.AppSyncAuthorizationType.IAM],
        defaultSubscribeAuthModeTypes: [appsync.AppSyncAuthorizationType.IAM],
      },
    });

    new appsync.ChannelNamespace(this, 'Namespace', {
      api,
      channelNamespaceName: 'event-bus',
      code: appsync.Code.fromAsset(join(__dirname, 'resources', 'bus-event-handler.mjs')),
    });

    this.httpEndpoint = `https://${api.httpDns}`;
    this.api = api;
  }

  public addUserPoolProvider(userPool: IUserPool) {
    if (this.userPoolCount == 0) {
      (this.api.node.defaultChild as CfnResource).addPropertyOverride('EventConfig.ConnectionAuthModes.1', {
        AuthType: 'AMAZON_COGNITO_USER_POOLS',
      });
      (this.api.node.defaultChild as CfnResource).addPropertyOverride('EventConfig.DefaultSubscribeAuthModes.1', {
        AuthType: 'AMAZON_COGNITO_USER_POOLS',
      });
    }

    this.userPoolCount += 1;
    (this.api.node.defaultChild as CfnResource).addPropertyOverride(`EventConfig.AuthProviders.${this.userPoolCount}`, {
      AuthType: 'AMAZON_COGNITO_USER_POOLS',
      CognitoConfig: {
        AwsRegion: Stack.of(this).region,
        UserPoolId: userPool.userPoolId,
      },
    });
  }
}

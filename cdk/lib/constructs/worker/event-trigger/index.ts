import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as path from 'path';
import { ITableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { WorkerBus } from '../bus';

export interface EventTriggerProps {
  storageTable: ITableV2;
  bus: WorkerBus;
  userPool: cognito.UserPool;
  cognitoDomainName: string;
}

export class EventTrigger extends Construct {
  public readonly handlerStateMachine: sfn.StateMachine;
  public readonly ttlStateMachine: sfn.StateMachine;
  public readonly schedulerRole: iam.Role;
  public readonly resourcePrefix: string;

  constructor(scope: Construct, id: string, props: EventTriggerProps) {
    super(scope, id);

    const region = cdk.Stack.of(this).region;
    const account = cdk.Stack.of(this).account;

    // Generate a short stack-specific prefix for EventBridge resources (max ~15 chars)
    this.resourcePrefix = cdk.Names.uniqueResourceName(this, { maxLength: 15 }).toLowerCase();

    // Cognito Resource Server + M2M Client for AppSync publish-only access
    const resourceServer = props.userPool.addResourceServer('EventTriggerResourceServer', {
      identifier: 'appsync-events',
      scopes: [{ scopeName: 'publish', scopeDescription: 'Publish events to AppSync Event API' }],
    });

    const m2mClient = props.userPool.addClient('EventTriggerM2MClient', {
      generateSecret: true,
      oAuth: {
        flows: { clientCredentials: true },
        scopes: [cognito.OAuthScope.custom('appsync-events/publish')],
      },
    });
    m2mClient.node.addDependency(resourceServer);

    // EventBridge Connection with OAuth client_credentials → Cognito token endpoint
    const tokenEndpoint = `https://${props.cognitoDomainName}/oauth2/token`;

    const connection = new events.Connection(this, 'AppSyncConnection', {
      authorization: events.Authorization.oauth({
        authorizationEndpoint: tokenEndpoint,
        httpMethod: events.HttpMethod.POST,
        clientId: m2mClient.userPoolClientId,
        clientSecret: m2mClient.userPoolClientSecret,
        bodyParameters: {
          grant_type: events.HttpParameter.fromString('client_credentials'),
          scope: events.HttpParameter.fromString('appsync-events/publish'),
        },
      }),
    });

    const eventHttpEndpoint = `https://${props.bus.api.httpDns}`;

    // Create Scheduler role first (referenced by SFN policies)
    this.schedulerRole = new iam.Role(this, 'SchedulerRole', {
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('scheduler.amazonaws.com'),
        new iam.ServicePrincipal('events.amazonaws.com')
      ),
    });

    // Step Functions with auto-generated roles
    const handlerAslPath = path.join(__dirname, 'event-trigger-handler.asl.json');
    this.handlerStateMachine = new sfn.StateMachine(this, 'HandlerStateMachine', {
      definitionBody: sfn.DefinitionBody.fromFile(handlerAslPath),
      definitionSubstitutions: {
        tableName: props.storageTable.tableName,
        eventHttpEndpoint,
        connectionArn: connection.connectionArn,
      },
      timeout: cdk.Duration.seconds(300),
    });

    const ttlAslPath = path.join(__dirname, 'event-trigger-ttl.asl.json');
    this.ttlStateMachine = new sfn.StateMachine(this, 'TtlStateMachine', {
      definitionBody: sfn.DefinitionBody.fromFile(ttlAslPath),
      definitionSubstitutions: {
        tableName: props.storageTable.tableName,
        eventHttpEndpoint,
        connectionArn: connection.connectionArn,
      },
      timeout: cdk.Duration.seconds(300),
    });

    // Grant common policies to both SFN roles
    let policyIndex = 0;
    const applyCommonPolicies = (role: iam.IRole) => {
      const idx = policyIndex++;
      props.storageTable.grantReadWriteData(role);

      role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ['ec2:DescribeInstances'],
          resources: ['*'],
        })
      );

      role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ['ec2:StartInstances'],
          resources: [`arn:aws:ec2:${region}:${account}:instance/*`],
          conditions: {
            StringEquals: {
              'ec2:ResourceTag/aws:cloudformation:stack-name': cdk.Stack.of(this).stackName,
            },
          },
        })
      );

      role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ['bedrock-agentcore:InvokeAgentRuntime'],
          resources: [`arn:aws:bedrock-agentcore:${region}:${account}:runtime/*`],
        })
      );

      role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ['events:RetrieveConnectionCredentials'],
          resources: [connection.connectionArn],
        })
      );

      const connectionSecret = secretsmanager.Secret.fromSecretCompleteArn(
        this,
        `SfnRole${idx}ConnectionSecret`,
        connection.connectionSecretArn
      );
      connectionSecret.grantRead(role);

      role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ['states:InvokeHTTPEndpoint'],
          resources: ['*'],
          conditions: {
            StringEquals: {
              'states:HTTPMethod': 'POST',
            },
          },
        })
      );
    };

    applyCommonPolicies(this.handlerStateMachine.role);
    applyCommonPolicies(this.ttlStateMachine.role);

    // Handler needs scheduler permissions to reset idle timers on event fire
    this.handlerStateMachine.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['scheduler:CreateSchedule', 'scheduler:DeleteSchedule'],
        resources: [`arn:aws:scheduler:${region}:${account}:schedule/default/${this.resourcePrefix}-*`],
      })
    );

    this.handlerStateMachine.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [this.schedulerRole.roleArn],
        conditions: {
          StringEquals: {
            'iam:PassedToService': 'scheduler.amazonaws.com',
          },
        },
      })
    );

    // TTL role needs EventBridge cleanup permissions
    this.ttlStateMachine.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['events:RemoveTargets', 'events:DeleteRule'],
        resources: [`arn:aws:events:${region}:${account}:rule/${this.resourcePrefix}-*`],
      })
    );

    // Scheduler role can start both SFN state machines
    this.schedulerRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['states:StartExecution'],
        resources: [this.handlerStateMachine.stateMachineArn, this.ttlStateMachine.stateMachineArn],
      })
    );
  }

  public grantManage(grantee: iam.IGrantable) {
    const region = cdk.Stack.of(this).region;
    const account = cdk.Stack.of(this).account;

    grantee.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['scheduler:CreateSchedule', 'scheduler:DeleteSchedule', 'scheduler:GetSchedule'],
        resources: [`arn:aws:scheduler:${region}:${account}:schedule/default/${this.resourcePrefix}-*`],
      })
    );

    grantee.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          'events:PutRule',
          'events:PutTargets',
          'events:DeleteRule',
          'events:RemoveTargets',
          'events:DescribeRule',
          'events:ListRules',
        ],
        resources: [`arn:aws:events:${region}:${account}:rule/${this.resourcePrefix}-*`],
      })
    );

    grantee.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [this.schedulerRole.roleArn],
        conditions: {
          StringLike: {
            'iam:PassedToService': ['scheduler.amazonaws.com', 'events.amazonaws.com'],
          },
        },
      })
    );
  }
}

import { Duration } from 'aws-cdk-lib';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export interface EC2GarbageCollectorStepFunctionsProps {
  imageRecipeName?: string;
  expirationInDays?: number;
}

export class EC2GarbageCollectorStepFunctions extends Construct {
  public readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props?: EC2GarbageCollectorStepFunctionsProps) {
    super(scope, id);

    const expirationInDays = props?.expirationInDays || 1;
    const imageRecipeName = props?.imageRecipeName || '';

    // ====== EC2インスタンスクリーンアップフロー =====

    // 停止したEC2インスタンスを検索
    const describeStoppedInstances = new tasks.CallAwsService(this, 'DescribeStoppedInstances', {
      service: 'ec2',
      action: 'describeInstances',
      parameters: {
        Filters: [
          { Name: 'tag-key', Values: ['RemoteSweWorkerId'] },
          { Name: 'instance-state-name', Values: ['stopped'] }
        ]
      },
      iamResources: ['*'],
    });

    // フィルタリング処理を行うLambda関数
    const filterInstancesLambda = new lambda.Function(this, 'FilterInstancesLambda', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        exports.handler = async (event) => {
          console.log("Starting EC2 instance filter");
          const now = new Date();
          const expirationSeconds = event.expirationSeconds || (${expirationInDays} * 24 * 3600);
          
          const reservations = event.Reservations || [];
          const expiredInstanceIds = [];
          
          // Process all reservations and instances
          for (const reservation of reservations) {
            if (reservation.Instances) {
              for (const instance of reservation.Instances) {
                if (instance.LaunchTime) {
                  const launchTime = new Date(instance.LaunchTime);
                  const secondsSinceLaunch = (now.getTime() - launchTime.getTime()) / 1000;
                  
                  if (secondsSinceLaunch >= expirationSeconds && instance.InstanceId) {
                    console.log(\`Instance \${instance.InstanceId} has expired: \${secondsSinceLaunch} seconds since launch\`);
                    expiredInstanceIds.push(instance.InstanceId);
                  }
                }
              }
            }
          }
          
          console.log(\`Found \${expiredInstanceIds.length} expired instances\`);
          return { expiredInstanceIds };
        }
      `),
      timeout: Duration.seconds(30),
    });

    const invokeFilterInstances = new tasks.LambdaInvoke(this, 'FilterExpiredInstances', {
      lambdaFunction: filterInstancesLambda,
      payloadResponseOnly: true,
    });

    // インスタンスを終了
    const terminateInstances = new tasks.CallAwsService(this, 'TerminateInstances', {
      service: 'ec2',
      action: 'terminateInstances',
      parameters: {
        'InstanceIds.$': '$.expiredInstanceIds'
      },
      iamResources: ['*'],
    });

    // インスタンスがあるかチェック
    const instanceChoice = new sfn.Choice(this, 'InstancesExistCheck');
    const noInstancesToTerminate = new sfn.Pass(this, 'NoInstancesToTerminate');

    // EC2インスタンスクリーンアップフローの終了ポイント
    const instanceCleanupDone = new sfn.Pass(this, 'InstanceCleanupDone');

    // EC2インスタンスクリーンアップフロー - 最初の部分のみここで定義
    const instanceCleanupFirst = describeStoppedInstances
      .next(invokeFilterInstances);

    // Choiceステートの分岐を定義 - インスタンスクリーンアップ完了ポイントに合流
    const terminateAndDone = terminateInstances.next(instanceCleanupDone);
    const noTerminateAndDone = noInstancesToTerminate.next(instanceCleanupDone);
    
    instanceChoice
      .when(sfn.Condition.isPresent('$.expiredInstanceIds[0]'), terminateAndDone)
      .otherwise(noTerminateAndDone);

    // 完全なインスタンスクリーンアップフロー
    const instanceCleanupFlow = instanceCleanupFirst.next(instanceChoice);

    // ====== AMIクリーンアップフロー =====

    // 現在使用中のAMI IDを取得
    const getCurrentAmiId = new tasks.CallAwsService(this, 'GetCurrentAmiId', {
      service: 'ssm',
      action: 'getParameter',
      parameters: {
        'Name': '/remote-swe/worker/ami-id'
      },
      iamResources: ['*'],
      resultPath: '$.currentAmiResult',
    });

    // AMIを検索
    const describeAmis = new tasks.CallAwsService(this, 'DescribeAMIs', {
      service: 'ec2',
      action: 'describeImages',
      parameters: {
        Owners: ['self'],
        Filters: [
          {
            Name: 'name',
            Values: imageRecipeName ? [`${imageRecipeName}*`] : ['*']
          }
        ]
      },
      iamResources: ['*'],
      resultPath: '$.imagesResult',
    });

    // AMIフィルタリング - JSONataを使用
    const filterAmis = sfn.Pass.jsonata(this, 'FilterAMIs', {
      outputs: {
        'filteredImages': `{% 
          $exists($filter(
            $states.input.imagesResult.Images, 
            function($image) { 
              $exists($image.ImageId) and
              $exists($image.CreationDate) and
              $image.ImageId != $states.input.currentAmiResult.Parameter.Value and
              $number($millis($now()) - $millis($image.CreationDate)) / (1000 * 3600 * 24) > 1
            }
          )) ? 
          $filter(
            $states.input.imagesResult.Images, 
            function($image) { 
              $exists($image.ImageId) and
              $exists($image.CreationDate) and
              $image.ImageId != $states.input.currentAmiResult.Parameter.Value and
              $number($millis($now()) - $millis($image.CreationDate)) / (1000 * 3600 * 24) > 1
            }
          ) : []
        %}`
      }
    });

    // AMI処理用のマップ状態
    const amiMap = new sfn.Map(this, 'ProcessAMIs', {
      maxConcurrency: 10,
      itemsPath: '$.filteredImages',
    });

    // ===== AMIクリーンアップ処理（Step Functionsネイティブ実装） =====
    
    // AMIの登録解除
    const deregisterImage = new tasks.CallAwsService(this, 'DeregisterImage', {
      service: 'ec2',
      action: 'deregisterImage',
      parameters: {
        'ImageId.$': '$$.Map.Item.Value.ImageId'
      },
      iamResources: ['*'],
      resultPath: '$.deregisterResult',
    });

    // 2. スナップショットを処理するマップステート
    const processSnapshots = new sfn.Map(this, 'ProcessSnapshots', {
      maxConcurrency: 5,
      itemsPath: '$$.Map.Item.Value.BlockDeviceMappings',
    });

    // スナップショットの存在チェック
    const hasSnapshotId = new sfn.Choice(this, 'HasSnapshotId');
    const noSnapshotToDelete = new sfn.Pass(this, 'NoSnapshotToDelete');
    
    // スナップショット処理の終了ポイント
    const snapshotDone = new sfn.Pass(this, 'SnapshotDone');

    // スナップショット削除フロー
    processSnapshots.itemProcessor(
      hasSnapshotId
        .when(sfn.Condition.isPresent('$$.Map.Item.Value.Ebs.SnapshotId'), 
          new tasks.CallAwsService(this, 'DeleteSnapshotInMap', {
            service: 'ec2',
            action: 'deleteSnapshot',
            parameters: {
              'SnapshotId.$': '$$.Map.Item.Value.Ebs.SnapshotId'
            },
            iamResources: ['*'],
            resultPath: '$.deleteSnapshotResult',
          }).next(snapshotDone)
        )
        .otherwise(noSnapshotToDelete.next(snapshotDone))
    );

    // 3. Image Builderタグをチェックするためのステップ
    const findImageBuilderTag = new sfn.Pass(this, 'FindImageBuilderTag', {
      parameters: {
        'Tags.$': '$$.Map.Item.Value.Tags'
      },
    });
    
    // Image Builderタグがあるかチェック
    const hasImageBuilderTag = new sfn.Choice(this, 'HasImageBuilderTag');
    const noImageBuilderToDelete = new sfn.Pass(this, 'NoImageBuilderToDelete');
    
    // Image Builderのタグから特定のキーを持つものを探す
    const findEc2ImageBuilderArnTag = new sfn.Pass(this, 'FindEc2ImageBuilderArnTag', {
      inputPath: '$.Tags',
      resultPath: '$.tagList',
    });
    
    // 特定のタグがあるかチェック
    const hasTagChoice = new sfn.Choice(this, 'HasTagChoice');
    
    // Image BuilderのARNをJSONataを使って抽出
    const filterTagsPass = sfn.Pass.jsonata(this, 'FilterTagsPass', {
      outputs: {
        'TagValue': `{% 
          $exists($filter($states.input.tagList, function($tag) { $tag.Key = "Ec2ImageBuilderArn" })[0]) ?
          $filter($states.input.tagList, function($tag) { $tag.Key = "Ec2ImageBuilderArn" })[0].Value : ""
        %}`
      }
    });

    // Image Builderイメージを削除
    const deleteImageBuilderImage = new tasks.CallAwsService(this, 'DeleteImageBuilderImage', {
      service: 'imagebuilder',
      action: 'deleteImage',
      parameters: {
        'ImageBuildVersionArn.$': '$.filteredTag.TagValue'
      },
      iamResources: ['*'],
      resultPath: '$.deleteImageBuilderResult',
    });
    
    // 異なる終了ノードを作成
    const noImageBuilderToProcess = new sfn.Pass(this, 'NoImageBuilderToProcess');
    const imageBuilderDone = new sfn.Pass(this, 'ImageBuilderDone');
    const emptyTagValue = new sfn.Pass(this, 'EmptyTagValue');

    // Image Builder削除フロー - 各パスで別々のPassノードを使う
    hasImageBuilderTag
      .when(
        sfn.Condition.isPresent('$.Tags[0]'), 
        findEc2ImageBuilderArnTag
          .next(filterTagsPass)
          .next(
            hasTagChoice
              .when(sfn.Condition.stringEquals('$.filteredTag.TagValue', '{}'), emptyTagValue.next(imageBuilderDone))
              .otherwise(deleteImageBuilderImage.next(imageBuilderDone))
          )
      )
      .otherwise(noImageBuilderToProcess.next(imageBuilderDone));

    // AMI処理全体のフロー
    const amiCleanupDefinition = deregisterImage
      .next(processSnapshots)
      .next(findImageBuilderTag)
      .next(hasImageBuilderTag);
      
    amiMap.itemProcessor(amiCleanupDefinition);

    // AMIがあるかチェック
    const amiChoice = new sfn.Choice(this, 'AmisExistCheck');
    const noAmisToDelete = new sfn.Pass(this, 'NoAmisToDelete');
    
    // AMIクリーンアップフローの終了ポイント
    const amiCleanupDone = new sfn.Pass(this, 'AmiCleanupDone');

    // AMIクリーンアップフロー - 最初の部分のみここで定義
    const amiCleanupFirst = getCurrentAmiId
      .next(describeAmis)
      .next(filterAmis);

    // Choiceステートの分岐を定義 - AMIクリーンアップ完了ポイントに合流
    const mapAndDone = amiMap.next(amiCleanupDone);
    const noDeleteAndDone = noAmisToDelete.next(amiCleanupDone);
    
    amiChoice
      .when(sfn.Condition.isPresent('$.filteredImages[0]'), mapAndDone)
      .otherwise(noDeleteAndDone);

    // 完全なAMIクリーンアップフロー
    const amiCleanupFlow = amiCleanupFirst.next(amiChoice);

    // ステートマシン全体のフロー - シーケンシャルに実行
    const cleanupDone = new sfn.Pass(this, 'CleanupCompleted');
    
    // ベース定義（EC2インスタンスクリーンアップ）
    // instanceCleanupFlowはinstanceCleanupDoneで終わるので、amiCleanupFlowを直接接続
    let definition = instanceCleanupFlow;
    
    // imageRecipeNameが指定されている場合のみAMIクリーンアップを追加
    if (imageRecipeName) {
      // instanceCleanupFlowの終了ポイントからamiCleanupFlowへ接続
      instanceCleanupDone.next(amiCleanupFlow);
    } else {
      // AMIクリーンアップが不要な場合は、instanceCleanupDoneからcleanupDoneへ接続
      instanceCleanupDone.next(cleanupDone);
    }
    
    // 最後のステップとしてamiCleanupDoneからcleanupDoneへ接続
    if (imageRecipeName) {
      amiCleanupDone.next(cleanupDone);
    }

    // ステートマシンの作成
    this.stateMachine = new sfn.StateMachine(this, 'EC2GarbageCollectorStateMachine', {
      definition,
      timeout: Duration.minutes(10),
      tracingEnabled: true,
    });

    // IAMポリシーの設定
    this.stateMachine.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'ec2:DescribeInstances',
          'ec2:TerminateInstances',
          'ec2:DescribeImages',
          'ec2:DeregisterImage',
          'ec2:DeleteSnapshot',
          'ssm:GetParameter',
          'imagebuilder:DeleteImage'
        ],
        resources: ['*'],
      })
    );

    // Lambda実行権限
    filterInstancesLambda.grantInvoke(this.stateMachine);
    
    // AWS SDKの使用権限をLambdaに付与
    filterInstancesLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ec2:DescribeInstances'],
        resources: ['*'],
      })
    );

    // CloudWatch Eventsルールの設定
    const schedule = new events.Rule(this, 'Schedule', {
      schedule: events.Schedule.rate(Duration.hours(2)),
    });

    schedule.addTarget(new targets.SfnStateMachine(this.stateMachine));
  }
}

import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { WorkerBus } from './bus';
import { BlockPublicAccess, Bucket, IBucket } from 'aws-cdk-lib/aws-s3';
import { AssetHashType, DockerImage, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { join } from 'path';
import { ITableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { IStringParameter, StringParameter } from 'aws-cdk-lib/aws-ssm';
import * as logs from 'aws-cdk-lib/aws-logs';
import { WorkerImageBuilder } from './image-builder';

export interface WorkerProps {
  vpc: ec2.IVpc;
  storageTable: ITableV2;
  imageBucket: IBucket;
  slackBotTokenParameter: IStringParameter;
  gitHubApp?: {
    privateKeyParameterName: string;
    appId: string;
    installationId: string;
  };
  githubPersonalAccessTokenParameter?: IStringParameter;
  loadBalancing?: {
    awsAccounts: string[];
    roleName: string;
  };
  accessLogBucket: IBucket;
  amiIdParameterName: string;
}

export class Worker extends Construct {
  public readonly launchTemplate: ec2.LaunchTemplate;
  public readonly bus: WorkerBus;
  public readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: WorkerProps) {
    super(scope, id);

    const { vpc } = props;

    // Create CloudWatch LogGroup for worker logs
    this.logGroup = new logs.LogGroup(this, 'LogGroup', {
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const privateKey = props.gitHubApp
      ? StringParameter.fromStringParameterAttributes(this, 'GitHubAppPrivateKey', {
          parameterName: props.gitHubApp.privateKeyParameterName,
          forceDynamicReference: true,
        })
      : undefined;

    const sourceBucket = new Bucket(this, 'SourceBucket', {
      autoDeleteObjects: true,
      removalPolicy: RemovalPolicy.DESTROY,
      enforceSSL: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      serverAccessLogsBucket: props.accessLogBucket,
      serverAccessLogsPrefix: 's3AccessLog/SourceBucket/',
    });

    const bus = new WorkerBus(this, 'Bus', {});
    this.bus = bus;

    new BucketDeployment(this, 'SourceDeployment', {
      destinationBucket: sourceBucket,
      sources: [
        // specify a dummy directory. All the input files are already in the image.
        Source.asset(join('..', 'resources'), {
          bundling: {
            command: [
              'sh',
              '-c',
              [
                //
                'cd /asset-input',
                'tar -zcf source.tar.gz -C /build/ .',
                'mkdir -p /asset-output/source',
                'mv source.tar.gz /asset-output/source',
              ].join('&&'),
            ],
            image: DockerImage.fromBuild('..', { file: join('docker', 'worker.Dockerfile') }),
          },
          assetHashType: AssetHashType.OUTPUT,
        }),
      ],
    });

    const role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });

    const launchTemplate = new ec2.LaunchTemplate(this, 'LaunchTemplate', {
      machineImage: ec2.MachineImage.fromSsmParameter(
        '/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id'
      ),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.LARGE),
      blockDevices: [
        {
          deviceName: '/dev/sda1',
          volume: ec2.BlockDeviceVolume.ebs(50, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
          }),
        },
      ],
      role,
      requireImdsv2: true,
      instanceMetadataTags: true,
      securityGroup: new ec2.SecurityGroup(this, 'SecurityGroup', {
        vpc,
      }),
    });
    const userData = launchTemplate.userData!;

    userData.addCommands(
      `
apt-get -o DPkg::Lock::Timeout=-1 update
apt-get -o DPkg::Lock::Timeout=-1 install -y docker.io python3-pip unzip
ln -s -f /usr/bin/pip3 /usr/bin/pip
ln -s -f /usr/bin/python3 /usr/bin/python

# Install Node.js
sudo -u ubuntu bash -c "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | bash"
sudo -u ubuntu bash -c -i "nvm install 22"

# Install AWS CLI
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip -q awscliv2.zip
sudo ./aws/install

# Install Fluent Bit
curl https://raw.githubusercontent.com/fluent/fluent-bit/master/install.sh | sh

# Install GitHub CLI https://github.com/cli/cli/blob/trunk/docs/install_linux.md
(type -p wget >/dev/null || (sudo apt update && sudo apt-get install wget -y)) \
  && sudo mkdir -p -m 755 /etc/apt/keyrings \
  && out=$(mktemp) && wget -nv -O$out https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  && cat $out | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
  && sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && sudo apt-get -o DPkg::Lock::Timeout=-1 update \
  && sudo apt-get -o DPkg::Lock::Timeout=-1 install gh -y

# Configure Git user for ubuntu
sudo -u ubuntu bash -c 'git config --global user.name "remote-swe-app[bot]"'
sudo -u ubuntu bash -c 'git config --global user.email "${props.gitHubApp?.appId ?? '123456'}+remote-swe-app[bot]@users.noreply.github.com"'

# install uv
sudo -u ubuntu bash -c 'curl -LsSf https://astral.sh/uv/install.sh | sh'
      `.trim()
    );

    if (privateKey) {
      // install gh-token to obtain github token using github apps credentials
      userData.addCommands(
        `
aws ssm get-parameter \
    --name ${privateKey.parameterName} \
    --query "Parameter.Value" \
    --output text > /opt/private-key.pem
curl -L "https://github.com/Link-/gh-token/releases/download/v2.0.4/linux-amd64" -o gh-token
chmod +x gh-token
mv gh-token /usr/bin
      `.trim()
      );
    }

    userData.addCommands(
      `
mkdir -p /opt/myapp && cd /opt/myapp
chown -R ubuntu:ubuntu /opt/myapp

# Install Playwright dependencies
sudo -u ubuntu bash -i -c "npx playwright install-deps"
sudo -u ubuntu bash -i -c "npx playwright install chromium"

# Configure GitHub CLI
sudo -u ubuntu bash -c "gh config set prompt disabled"

# Create setup script
mkdir -p /opt/scripts
cat << 'EOF' > /opt/scripts/start-app.sh
#!/bin/bash -l

# File paths for source and etag
SOURCE_BUCKET="${sourceBucket.bucketName}"
SOURCE_KEY="source/source.tar.gz"
SOURCE_ETAG_FILE="/opt/myapp/source.etag"
SOURCE_DIR="/opt/myapp"
CURRENT_DIR=$(pwd)

# Function to download and extract source
download_and_extract_source() {
  # Clean up existing files
  rm -rf ./{*,.*}

  # Download source code from S3
  aws s3 cp s3://$SOURCE_BUCKET/$SOURCE_KEY ./source.tar.gz
  
  # Save the etag
  aws s3api head-object --bucket $SOURCE_BUCKET --key $SOURCE_KEY --query ETag --output text > $SOURCE_ETAG_FILE
  
  # Extract and clean up
  tar -xvzf source.tar.gz
  rm -f source.tar.gz

  # Install dependencies and build
  npm ci
  npm run build -w packages/agent-core
}

# Check if we need to download the source again
DOWNLOAD_NEEDED=true

if [ -f "$SOURCE_ETAG_FILE" ] && [ -d "$SOURCE_DIR/node_modules" ]; then
  # Get the saved etag
  SAVED_ETAG=$(cat $SOURCE_ETAG_FILE)
  
  # Get the current etag
  CURRENT_ETAG=$(aws s3api head-object --bucket $SOURCE_BUCKET --key $SOURCE_KEY --query ETag --output text)
  
  # Compare etags
  if [ "$SAVED_ETAG" == "$CURRENT_ETAG" ]; then
    echo "Source code unchanged. Using existing installation."
    DOWNLOAD_NEEDED=false
  else
    echo "Source code has changed. Downloading new version."
  fi
else
  echo "No previous installation found or etag file missing. Downloading source."
fi

if [ "$DOWNLOAD_NEEDED" == "true" ]; then
  download_and_extract_source
fi

# Set up dynamic environment variables
TOKEN=$(curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 900")
export WORKER_ID=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" -v http://169.254.169.254/latest/meta-data/tags/instance/RemoteSweWorkerId)
export SLACK_CHANNEL_ID=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" -v http://169.254.169.254/latest/meta-data/tags/instance/SlackChannelId)
export SLACK_THREAD_TS=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" -v http://169.254.169.254/latest/meta-data/tags/instance/SlackThreadTs)
export SLACK_BOT_TOKEN=$(aws ssm get-parameter --name ${props.slackBotTokenParameter.parameterName} --query "Parameter.Value" --output text)
export GITHUB_PERSONAL_ACCESS_TOKEN=${props.githubPersonalAccessTokenParameter ? `$(aws ssm get-parameter --name ${props.githubPersonalAccessTokenParameter.parameterName} --query \"Parameter.Value\" --output text)` : '""'}

# Start app
cd packages/worker
npx tsx src/main.ts
EOF

# Make script executable and set ownership
chmod +x /opt/scripts/start-app.sh
chown ubuntu:ubuntu /opt/scripts/start-app.sh

cat << EOF > /etc/systemd/system/myapp.service
[Unit]
Description=My Node.js Application
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/myapp

ExecStart=/bin/bash -i -c /opt/scripts/start-app.sh
Restart=always
RestartSec=10
TimeoutStartSec=600
TimeoutStopSec=10s
StandardOutput=journal
StandardError=journal
SyslogIdentifier=myapp
# Static environment variables
Environment=AWS_REGION=${Stack.of(this).region}
Environment=EVENT_HTTP_ENDPOINT=${bus.httpEndpoint}
Environment=GITHUB_APP_PRIVATE_KEY_PATH=${privateKey ? '/opt/private-key.pem' : ''}
Environment=GITHUB_APP_ID=${props.gitHubApp?.appId ?? ''}
Environment=GITHUB_APP_INSTALLATION_ID=${props.gitHubApp?.installationId ?? ''}
Environment=TABLE_NAME=${props.storageTable.tableName}
Environment=BUCKET_NAME=${props.imageBucket.bucketName}
Environment=BEDROCK_AWS_ACCOUNTS=${props.loadBalancing?.awsAccounts.join(',') ?? ''}
Environment=BEDROCK_AWS_ROLE_NAME=${props.loadBalancing?.roleName ?? ''}
# Environment=MODEL_OVERRIDE=nova-pro

[Install]
WantedBy=multi-user.target
EOF
`.trim()
    );

    userData.addCommands(`
# Configure Fluent Bit for CloudWatch Logs
mkdir -p /etc/fluent-bit

cat << EOF > /etc/fluent-bit/fluent-bit.conf
[SERVICE]
    Flush        5
    Daemon       Off
    Log_Level    info

[INPUT]
    Name         systemd
    Tag          myapp
    Systemd_Filter    _SYSTEMD_UNIT=myapp.service

[FILTER]
    Name         modify
    Match        myapp
    Remove_regex ^(?!MESSAGE).+$

[OUTPUT]
    Name         cloudwatch_logs
    Match        myapp
    region       ${Stack.of(this).region}
    log_group_name    ${this.logGroup.logGroupName}
    log_stream_name   log-\\\${WORKER_ID}
    auto_create_group false
EOF

# Create Fluent Bit startup script
cat << 'EOF' > /opt/scripts/start-fluent-bit.sh
#!/bin/bash

TOKEN=$(curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 900")
export WORKER_ID=$(curl -H "X-aws-ec2-metadata-token: $TOKEN" -v http://169.254.169.254/latest/meta-data/tags/instance/RemoteSweWorkerId)

exec /opt/fluent-bit/bin/fluent-bit -c /etc/fluent-bit/fluent-bit.conf
EOF

# Make script executable
chmod +x /opt/scripts/start-fluent-bit.sh

# Create and configure Fluent Bit systemd service
cat << EOF > /etc/systemd/system/fluent-bit.service
[Unit]
Description=Fluent Bit
After=network.target

[Service]
Type=simple
ExecStart=/opt/scripts/start-fluent-bit.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable fluent-bit
systemctl enable myapp
      `);

    const installDependenciesCommand = userData.render();

    userData.addCommands(
      `
systemctl start fluent-bit
systemctl start myapp
      `.trim()
    );

    this.launchTemplate = launchTemplate;

    new WorkerImageBuilder(this, 'ImageBuilder', {
      vpc,
      installDependenciesCommand,
      amiIdParameterName: props.amiIdParameterName,
    });

    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: ['*'],
      })
    );
    if (props.loadBalancing) {
      role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ['sts:AssumeRole'],
          resources: [`arn:aws:iam::*:role/${props.loadBalancing!.roleName}`],
        })
      );
    }
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['ec2:TerminateInstances', 'ec2:StopInstances'],
        resources: ['*'],
        // can only terminate themselves
        conditions: {
          StringEquals: {
            'aws:ARN': '${ec2:SourceInstanceARN}',
          },
        },
      })
    );
    sourceBucket.grantRead(role);
    props.storageTable.grantReadWriteData(role);
    props.imageBucket.grantReadWrite(role);
    privateKey?.grantRead(role);
    props.githubPersonalAccessTokenParameter?.grantRead(role);
    props.slackBotTokenParameter.grantRead(role);
    bus.api.grantSubscribe(role);
    bus.api.grantConnect(role);

    // Grant permissions to write logs to CloudWatch
    this.logGroup.grantWrite(role);
  }
}

import { CfnResource, CustomResource, Duration, Stack } from 'aws-cdk-lib';
import { ITableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { IVpc, SecurityGroup, UserData } from 'aws-cdk-lib/aws-ec2';
import { IBucket } from 'aws-cdk-lib/aws-s3';
import { IStringParameter, StringParameter } from 'aws-cdk-lib/aws-ssm';
import { ImagePipeline, ImagePipelineProps } from 'cdk-image-pipeline';
import { Construct } from 'constructs';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { WorkerBus } from './bus';
import { ILogGroup } from 'aws-cdk-lib/aws-logs';
import * as yaml from 'yaml';
import { Code, Runtime, SingletonFunction } from 'aws-cdk-lib/aws-lambda';

export interface WorkerImageBuilderProps {
  vpc: IVpc;

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
  sourceBucket: IBucket;
  bus: WorkerBus;
  logGroup: ILogGroup;
}

export class WorkerImageBuilder extends Construct {
  constructor(scope: Construct, id: string, props: WorkerImageBuilderProps) {
    super(scope, id);

    const { vpc, sourceBucket, bus, logGroup } = props;

    const privateKey = props.gitHubApp
      ? StringParameter.fromStringParameterAttributes(this, 'GitHubAppPrivateKey', {
          parameterName: props.gitHubApp.privateKeyParameterName,
          forceDynamicReference: true,
        })
      : undefined;

    const componentTemplateString = readFileSync(
      join(__dirname, 'resources', 'image-component-template.yml')
    ).toString();
    const componentTemplate = yaml.parse(componentTemplateString);
    const userData = UserData.forLinux();

    userData.addCommands(
      `
apt-get -o DPkg::Lock::Timeout=-1 update
apt-get -o DPkg::Lock::Timeout=-1 install -y docker.io python3-pip unzip
ln -s -f /usr/bin/pip3 /usr/bin/pip
ln -s -f /usr/bin/python3 /usr/bin/python

# Install Node.js
snap install node --channel=22/stable --classic

# Install AWS CLI
snap install aws-cli --classic

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

# Create setup script
mkdir -p /opt/scripts
cat << 'EOF' > /opt/scripts/start-app.sh
#!/bin/bash -l

# Clean up existing files
rm -rf ./{*,.*}

# Download source code from S3
aws s3 cp s3://${sourceBucket.bucketName}/source/source.tar.gz ./source.tar.gz

# Extract and clean up
tar -xvzf source.tar.gz
rm -f source.tar.gz

# Install dependencies and build
npm ci
npm run build -w packages/agent-core

# Install Playwright dependencies
npx playwright install-deps
npx playwright install chromium

# Configure GitHub CLI
gh config set prompt disabled

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

ExecStart=/opt/scripts/start-app.sh
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
    log_group_name    ${logGroup.logGroupName}
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
      `);

    userData.addCommands(
      `
systemctl daemon-reload
systemctl enable fluent-bit
systemctl enable myapp
systemctl start fluent-bit
systemctl start myapp
      `.trim()
    );

    componentTemplate.phases[0].steps[1].inputs.commands = [userData.render()];
    writeFileSync(
      join(__dirname, 'resources', `${Stack.of(this).stackName}-image-component.yml`),
      yaml.stringify(componentTemplate, { lineWidth: 0 })
    );

    // The CloudMap service is created implicitly via ECS Service Connect.
    // That is why we fetch the ARN of the service via CFn custom resource.
    const versioningHandler = new SingletonFunction(this, 'ComponentVersioningHandler', {
      runtime: Runtime.NODEJS_22_X,
      handler: 'index.handler',
      timeout: Duration.seconds(5),
      lambdaPurpose: 'ImageBuilderVersioning',
      uuid: '153e8b47-ce27-4abc-a3b1-ad890c5d81e4',
      code: Code.fromInline(`
const response = require('cfn-response');

exports.handler = async function (event, context) {
  try {
    console.log(event);
    if (event.RequestType == 'Delete') {
      return await response.send(event, context, response.SUCCESS);
    }
    const initialVersion = event.ResourceProperties.initialVersion;
    if (event.RequestType == 'Create') {
      return await response.send(event, context, response.SUCCESS, { version: initialVersion }, initialVersion);
    }
    if (event.RequestType == 'Update') {
      const currentVersion = event.PhysicalResourceId; // e.g. 1.0.0
      // increment patch version
      const [major, minor, patch] = currentVersion.split('.').map(Number);
      const [oMajor, oMinor, oPatch] = initialVersion.split('.').map(Number);
      let newVersion = [major, minor, patch + 1].join('.');
      if (oMajor > major || (oMajor == major && oMinor > minor)) {
        newVersion = initialVersion;
      }
      await response.send(event, context, response.SUCCESS, { version: newVersion }, newVersion);
    }
  } catch (e) {
    console.log(e);
    await response.send(event, context, response.FAILED);
  }
};
`),
    });

    const securityGroup = new SecurityGroup(this, 'SecurityGroup', { vpc });

    const componentVersion = new CustomResource(this, 'WorkerDependenciesComponentVersion', {
      serviceToken: versioningHandler.functionArn,
      resourceType: 'Custom::ImageBuilderVersioning',
      properties: { initialVersion: '0.0.1', key: yaml.stringify(componentTemplate, { lineWidth: 0 }) },
      serviceTimeout: Duration.seconds(20),
    });

    const imagePipelineProps: Omit<ImagePipelineProps, 'imageRecipeVersion'> = {
      components: [
        {
          document: join(__dirname, 'resources', `${Stack.of(this).stackName}-image-component.yml`),
          name: 'WorkerDependencies',
          version: componentVersion.getAttString('version'),
        },
      ],
      parentImage: StringParameter.fromStringParameterAttributes(this, 'ParentImageId', {
        parameterName: '/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id',
        forceDynamicReference: true,
      }).stringValue,
      subnetId: vpc.publicSubnets[0].subnetId,
      securityGroups: [securityGroup.securityGroupId],
      ebsVolumeConfigurations: [
        {
          deviceName: '/dev/sda1',
          ebs: {
            encrypted: true,
            volumeSize: 50,
            volumeType: 'gp3',
          },
        },
      ],
    };

    const recipeVersion = new CustomResource(this, 'RecipeVersion', {
      serviceToken: versioningHandler.functionArn,
      resourceType: 'Custom::ImageBuilderVersioning',
      properties: { initialVersion: '0.1.0', key: JSON.stringify(imagePipelineProps) },
      serviceTimeout: Duration.seconds(20),
    });

    const pipeline = new ImagePipeline(this, 'ImagePipeline', {
      ...imagePipelineProps,
      imageRecipeVersion: recipeVersion.getAttString('version'),
    });
    // avoid duplicated SSM state association
    (pipeline.node.findChild('ImagePipeline') as CfnResource).addPropertyOverride('EnhancedImageMetadataEnabled', false);
  }
}

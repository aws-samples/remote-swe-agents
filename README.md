# Remote SWE Agents

This is an example implementation of a fully autonomous software development AI agent. The agent works in its own dedicated development environment, freeing you from being tied to your laptop!

**TL;DR:** This is a self-hosted, fully open-source solution on AWS that offers a similar experience to Devin, OpenAI Codex, or Google Jules.

*日本語版のREADMEは[こちら](README_ja.md)をご覧ください。*

![Concept](./docs/imgs/concept.png)

## Key Features

* **Fully autonomous software development agent** - AI-powered development workflow automation
* **Web-based management interface** - Modern Next.js webapp for session management and real-time monitoring
* **Comprehensive API** - RESTful endpoints for programmatic integration and session control
* **Powered by AWS serverless services** with minimal maintenance costs
* **No upfront or fixed costs** while you don't use the system
* **MCP support** through integration with MCP servers
* **Efficient token usage** with prompt cache and middle-out strategy
* **Reads knowledge** from your preferred formats (.clinerules, CLAUDE.md, etc.)
* **Can work on OSS forked repositories**

## Examples 

Some of the agent sessions by Remote SWE agents:

| Example 1 | Example 2 | Example 3 | Example 4 |
|:--------:|:--------:|:--------:|:--------:|
| ![example1](./docs/imgs/example1.png) | ![example2](./docs/imgs/example2.png) | ![example3](./docs/imgs/example3.png) | ![example4](./docs/imgs/example4.png) |
| Instruct via GitHub issue. [Resulting PR](https://github.com/aws-samples/remote-swe-agents/pull/17) | single instruction to multiple repos [PR#1](https://github.com/aws-samples/trpc-nextjs-ssr-prisma-lambda/pull/16), [PR#2](https://github.com/aws-samples/prisma-lambda-cdk/pull/37), [PR#3](https://github.com/aws-samples/distributed-load-testing-with-locust-on-ecs/pull/25) | The agent can also input and output images as well. | The agent can speak other languages than English as well. [Resulting PR](https://github.com/tmokmss/deploy-time-build/pull/32) |

### Pull Requests Created by the Remote SWE Agents

You can view all the public pull requests created by the agent [here](https://github.com/search?q=is%3Apr+author%3Aremote-swe-user&type=pullrequests). All of the commits pushed from the GitHub user is written by the agent autonomously.

## Installation Steps

This project supports two installation patterns depending on your needs. Choose the pattern that best fits your requirements:

- **Pattern A (Web Interface Only)**: Quick setup for webapp access only
- **Pattern B (Web + Slack Integration)**: Full setup with both webapp and Slack bot functionality

### Prerequisites

- Node.js (version 22 or higher)
- npm (version 9 or higher)
- AWS CLI
- AWS IAM profile with appropriate permissions
- Docker
- Bedrock Claude Sonnet 3.7 model is [enabled on](https://docs.aws.amazon.com/bedrock/latest/userguide/getting-started.html#getting-started-model-access) us-west-2 regions
- GitHub Account
- Slack Workspace (only for Pattern B)

---

## Pattern A: Web Interface Only Setup

This pattern provides access to the system through the web interface and API endpoints only. Perfect for users who don't need Slack integration.

### Step 1: Clone the Repository

```bash
git clone https://github.com/aws-samples/remote-swe-agents.git
cd remote-swe-agents
```

### Step 2: Create SSM Parameters

Before setting up GitHub integration, create placeholder SSM parameters that will be referenced by CDK:

```bash
aws ssm put-parameter \
    --name /remote-swe/slack/bot-token \
    --value "placeholder" \
    --type String

aws ssm put-parameter \
    --name /remote-swe/slack/signing-secret \
    --value "placeholder" \
    --type String

aws ssm put-parameter \
    --name /remote-swe/github/personal-access-token \
    --value "placeholder" \
    --type String
```

### Step 3: GitHub Integration Setup

To interact with GitHub, you need to setup GitHub integration. You have two options for GitHub integration:

**Which option should you choose?**
- **Personal Access Token (Option 3A)**: Choose this for personal use or quick setup. It's simpler but tied to a single user account.
- **GitHub App (Option 3B)**: Recommended for team environments or organizational use. Provides more granular permissions and isn't tied to a personal account.

#### Option 3A: Personal Access Token (PAT)

1. Go to [GitHub Settings > Developer settings > Personal access tokens](https://github.com/settings/tokens)
2. Generate a new token (classic) with appropriate repository access
   * Required scopes: `repo, workflow, read:org`
   * The more scopes you permit, the more various tasks agents can perform
3. Update the SSM Parameter with the generated token string:
   ```bash
   aws ssm put-parameter \
      --name /remote-swe/github/personal-access-token \
      --value "your-access-token" \
      --type String \
      --overwrite
   ```

> [!NOTE]
> If you want to share the system with multiple developers, it is recommended to create a [machine user account for GitHub](https://docs.github.com/en/get-started/learning-about-github/types-of-github-accounts#user-accounts) instead of using your own account's PAT, to prevent misuse of personal privileges.

#### Option 3B: GitHub App

1. Go to [GitHub Settings > Developer settings > GitHub Apps](https://github.com/settings/apps)
2. Create a new GitHub App
3. Configure permissions and generate a private key
   - the required permissions: Actions(RW), Issues(RW), Pull requests(RW), Contents(RW)
4. Create a parameter of [AWS Systems Manager Parameter Store](https://console.aws.amazon.com/systems-manager/parameters) for the private key.
   - This parameter will be referenced from CDK (the default parameter name: `/remote-swe/github/app-private-key`).
   ```bash
   aws ssm put-parameter \
      --name /remote-swe/github/app-private-key \
      --value "$(cat your-private-key.pem)" \
      --type String
   ```
5. Install the app to a GitHub organization you want to use.
   - After installing the app, you can find the installation id from the URL (`https://github.com/organizations/<YOUR_ORG>/settings/installations/<INSTALLATION_ID>`)
6. Please take a note of the below values:
   - App ID (e.g. 12345678)
   - Installation ID (e.g. 12345678)
   - Private key parameter name in AWS Systems Manager Parameter Store

> [!NOTE]
> Currently when using with GitHub App, you can only use repositories under a single organization (i.e. app installation).

### Step 4: Environment Variables Setup

Create a `.env.local` file from the example template:

```bash
cp .env.local.example .env.local
```

Then edit `.env.local` to configure the required environment variables for deployment:

#### For GitHub App Integration:

When you use GitHub App integration (option 3B above), set the following variables in your `.env.local` file:

```sh
GITHUB_APP_ID=your-github-app-id
GITHUB_INSTALLATION_ID=your-github-installation-id
```

#### For Worker Instance Configuration:

You can configure additional managed policies to be attached to the worker instance role by adding this to your `.env.local` file. You can set both AWS Managed policy name and a policy's full ARN:

```sh
WORKER_ADDITIONAL_POLICIES=AmazonS3ReadOnlyAccess,arn:aws:iam::123456789012:policy/CustomPolicy
```

#### For Using Existing VPC:

If you want to use an existing VPC instead of creating a new one, you can specify the VPC ID by adding this to your `.env.local` file:

```sh
VPC_ID=vpc-12345abcdef
```

When this variable is set, the deployment will use the existing VPC instead of creating a new one.

#### For Webapp User Creation:

You can automatically create an initial webapp user during deployment by adding this to your `.env.local` file:

```sh
INITIAL_WEBAPP_USER_EMAIL=your-email@example.com
```

When this variable is set, a Cognito user will be created during deployment, and a temporary password will be sent to the specified email address. You can then use this email and temporary password to log into the webapp.

If you don't set this variable, you can manually create users later through the AWS Cognito Management Console. See [Creating a new user in the AWS Management Console](https://docs.aws.amazon.com/cognito/latest/developerguide/how-to-create-user-accounts.html#creating-a-new-user-using-the-console).

> [!NOTE]
> We use environment variables here to inject configuration from GitHub Actions variables. If this isn't convenient for you, you can simply hard-code the values in [`bin/cdk.ts`](cdk/bin/cdk.ts).

### Step 5: Deploy CDK

```bash
cd cdk && npm ci
npx cdk bootstrap
npx cdk deploy --all
```

Deployment usually takes about 10 minutes. 

**That's it!** After deployment, you can access your system via the `WebappUrl` shown in the CDK stack output.

---

## Pattern B: Web + Slack Integration Setup

This pattern includes everything from Pattern A plus Slack bot functionality.

### Step 1-5: Complete Pattern A Setup First

Follow all steps from Pattern A above to get the basic system running.

### Step 6: Slack App Setup

Now, you need to set up a Slack App to control agents through the Slack interface.

#### Create a Slack App

1. Go to [Slack Apps Dashboard](https://api.slack.com/apps)
2. Click "Create New App"
3. Choose "From manifest"
4. Use the provided Slack app manifest YAML file: [manifest.json](./resources/slack-app-manifest.json)
   - If your Slack workspace administrator permits granting broader permissions to bots, you can also use [slack-app-manifest-relaxed.json](./resources/slack-app-manifest-relaxed.json). This allows users to converse with the agent in Slack threads without having to mention the bot.
   - Please replace the endpoint URL (`https://redacted.execute-api.us-east-1.amazonaws.com`) with your actual URL
   - You can find your actual URL in the CDK deployment outputs as `SlackBoltEndpointUrl`
5. Please make note of the following values:
   - Signing Secret (found in Basic Information)
   - Bot Token (found in OAuth & Permissions, after installing to your workspace)

Please also refer to this document for more details: [Create and configure apps with manifests](https://api.slack.com/reference/manifests)

> [!NOTE]
> If you're using a shared (rather than personal) Slack workspace, consider setting the `SLACK_ADMIN_USER_ID_LIST` environment variable (see below) to control agent access. Without this restriction, anyone in the workspace can access the agents and potentially your GitHub content.

#### Update SSM Parameters for Slack

After creating a Slack app, register the secrets in your AWS account by the following command:

```bash
aws ssm put-parameter \
    --name /remote-swe/slack/bot-token \
    --value "your-slack-bot-token" \
    --type String \
    --overwrite

aws ssm put-parameter \
    --name /remote-swe/slack/signing-secret \
    --value "your-slack-signing-secret" \
    --type String \
    --overwrite
```

Replace `your-slack-bot-token` and `your-slack-signing-secret` with the actual values you obtained in the previous step. The parameters will be referenced from CDK.

### Step 7: (Optional) Restrict Access to the System from Slack

To control which members in the Slack workspace can access the agents, you can provide a comma-separated list of Slack User IDs by adding this to your `.env.local` file:

To get a member's Slack user ID, [follow these instructions](https://www.google.com/search?q=copy+member+id+slack).

```sh
SLACK_ADMIN_USER_ID_LIST=U123ABC456,U789XYZ012
```

All users except those with specified user IDs will receive an Unauthorized error when attempting to access the Slack app.

> [!NOTE]
> To grant a user access to the app, mention the app with an `approve_user` message followed by mentions of the users, e.g., `@remote-swe approve_user @Alice @Bob @Carol`

### Step 8: Re-deploy CDK with Slack Integration

After the above setup is complete, run `cdk deploy` again.

```bash
cd cdk
npx cdk deploy --all
```

**Done!** You now have access to both web interface and Slack bot functionality.

---

## Accessing Your Deployed System

After successful deployment, you can access the Remote SWE Agents system through:

1. **Web Interface**: Visit the webapp URL from your CDK Stack outputs (look for `WebappUrl` in the deployment output)
   - Access the modern web dashboard for session management
   - Create and monitor agent sessions in real-time
   - View cost analytics and system usage
   - Upload images and manage settings

2. **Slack Interface**: Simply mention the Slack app and start assigning tasks to the agents
   - Direct integration with your Slack workspace
   - Thread-based conversations with agents
   - Real-time progress updates

3. **API Access**: Use the RESTful API endpoints for programmatic integration
   - Session creation and management
   - Automated workflows and CI/CD integration
   - Custom application development

4. **GitHub Actions Integration**: Integrate with your repositories using GitHub Actions
   - Automatically trigger agents from GitHub events
   - Respond to issue comments and assignments
   - Seamless CI/CD integration

For tips on how to effectively use the agents, refer to the [Useful Tips](#useful-tips) section.

### GitHub Actions Integration

This repository can be used as a GitHub Action to automatically trigger Remote SWE agents from GitHub events like issue comments, assignments, and PR reviews. The GitHub Action uses the Remote SWE API functionality to create and manage agent sessions.

Use `aws-samples/remote-swe-agents` in your workflow and configure your API base URL and key as repository secrets. You can generate API keys from the deployed webapp interface. See [action.yml](./action.yml) for input parameters and [.github/workflows/remote-swe.yml](./.github/workflows/remote-swe.yml) for a complete example workflow.

### Tenant Isolation Model

This project is currently designed as a single-tenant system, meaning it is intended to be deployed on a per-tenant basis.

Since it follows a completely pay-as-you-go model, the overhead of deploying multiple instances is minimal in terms of infrastructure costs.

To control access for each tenant, you have the following access permission configurations:

1. **Slack App**: You can set the `SLACK_ADMIN_USER_ID_LIST` environment variable in CDK to deny access from non-permitted users. You can then add allowed users using the `approve_user` Slack command.
2. **Webapp**: Cognito self-sign-up is disabled by default. You can add users from the Cognito management console. Currently, anyone with a Cognito account has equal permissions. Users can configure the system, create new sessions, issue API keys, or view cost analysis from the web UI.
3. **REST API**: Anyone who knows the API keys can access it. You should delete keys that are no longer in use.
4. **GitHub Actions**: Anyone with write access to the repository (i.e., collaborators) can invoke the action.

## Useful Tips

### Prompting Best Practices

When you start an agent, your instruction should include at least the below content:

1. Which GitHub repository should they see
2. Describe the feature or bug you want to solve
3. What file should they check first (file path would be the best, but only keywords can also work)

To simplify the workflow, you can create a GitHub issue in the repository containing the information above, and just give the agent its URL.
This way the repository is automatically inferred from the URL, and it can also link the new PR to the corresponding issue.

### Integrating with MCP Servers

As our agent can work as an MCP client, you can easily integrate it with various MCP servers. To configure the integration, you can edit [`mcp.json`](./packages/worker/mcp.json) and run CDK deploy. For example,

```json
  "mcpServers": {
    "awslabs.cdk-mcp-server": {
      "command": "uvx",
      "args": ["awslabs.cdk-mcp-server@latest"],
      "env": {
        "FASTMCP_LOG_LEVEL": "ERROR"
      }
    }
  }
```

All the new agents can now use MCP servers as their tools.

### Overriding the Foundation Model

By default the Remote SWE uses Claude Sonnet 3.7 as the foundation model. You can override this configuration using an environment variable:

```bash
WORKER_MODEL_OVERRIDE=nova-pro npx cdk deploy
```

The available model values are: `sonnet3.5v1, sonnet3.5, sonnet3.7, haiku3.5, nova-pro, opus4, and sonnet4`

After deploying, new workers will use the override model.

Note that this feature is highly experimental and we generally recommend to use the default model for optimized experience.

## How it works

This system utilizes a Slack Bolt application to manage user interactions and implement a scalable worker system. Here's the main workflow:

1. **Message Reception and Processing**
   - When a user sends a message in Slack, it's forwarded to the Slack Bolt application via webhook
   - API Gateway receives the webhook request and passes it to a Lambda function

2. **Event Management and Message Distribution**
   - The Lambda function publishes user messages to AppSync Events
   - Message history is stored in DynamoDB for reference in subsequent processing

3. **Worker System Management**
   - When a new Slack thread is created, the Worker Manager is notified
   - The Worker Manager provisions a Worker Unit consisting of an EC2 instance and EBS volume
   - Each Worker Unit contains an SWE agent responsible for the actual processing

4. **Feedback Loop**
   - Worker Units subscribe to AppSync Events to receive user messages
   - Processing results and progress updates are sent back to Slack as replies to the user
   - Job statuses are managed in DynamoDB

This architecture enables a scalable and reliable messaging processing system. The combination of serverless components (Lambda, API Gateway) and dedicated EC2 instances per worker ensures resource isolation and flexible scalability.

![AWS architecture](./docs/imgs/architecture.png)

## Cost

The following table provides a sample cost breakdown for deploying this system in the us-east-1 (N. Virginia) region for one month.

Here we assume you request 100 sessions per month. The monthly cost is proportional to the number of sessions. (e.g. If you only run 20 session/month, multiply it with 20/100.)

| AWS service | Dimensions | Cost [USD/month] |
|-------------|------------|------------------|
| EC2 | t3.large, 1 hour/session | 8.32 |
| EBS | 30 GB/instance, 1 day/instance | 8.00 |
| DynamoDB | Read: 1000 RRU/session | 0.0125 |
| DynamoDB | Write: 200 WRU/session | 0.0125 |
| DynamoDB | Storage: 2 MB/session | 0.05 |
| AppSync Events | Requests: 20 events/session | 0.002 |
| AppSync Events | Connection: 1 hour/session | 0.00048 |
| Lambda | Requests: 30 invocations/session | 0.0006 |
| Lambda | Duration: 128MB, 1s/invocation | 0.00017 |
| API Gateway | Requests: 20 requests/session | 0.002 |
| Bedrock | Input (cache write): Sonnet 3.7 100k tokens/session | 37.5 |
| Bedrock | Input (cache read): Sonnet 3.7 1M tokens/session | 30.00 |
| Bedrock | Output: Sonnet 3.7 20k tokens/session | 30.00 |
| TOTAL | | 115 |

Additionally, when the system is not in use (i.e., no messages are sent to the agents), the ongoing costs are minimal (~0 USD).

## Clean up
You can clean up all the resources you created by the following commands:

```sh
npx cdk destroy --force
```

> [!NOTE]  
> When executing `cdk deploy`, an EC2 Image Builder pipeline is launched asynchronously. Please wait at least 30 minutes after deployment before destroying the stack. If stack deletion fails, wait about 30 minutes and try `cdk destroy` again.

## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## License

This library is licensed under the MIT-0 License. See the LICENSE file.

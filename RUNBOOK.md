# Remote SWE Agents Runbook (S0)

This runbook documents how this deployment is operated, upgraded, and torn down.

## Overview

- AWS account: `624143034767`
- Region: `us-west-2` (primary), `us-east-1` (edge resources)
- CDK stacks:
  - `RemoteSweStack-Sandbox` (us-west-2)
  - `RemoteSweUsEast1Stack-Sandbox` (us-east-1)
- VPC: `vpc-04b8a451ecea42e4e` (staging VPC, reused to avoid VPC/IGW limits)
- CDK env file: `cdk/.env.local`

## Key outputs

Get current stack outputs:

```bash
aws cloudformation describe-stacks \
  --stack-name RemoteSweStack-Sandbox \
  --region us-west-2 \
  --profile default \
  --query 'Stacks[0].Outputs[*].{Key:OutputKey,Value:OutputValue}' \
  --output table
```

Important values:
- `FrontendDomainName` (webapp URL)
- `SlackBoltEndpointUrl` (Slack request URL)
- `AuthUserPoolId*` and `AuthUserPoolClientId*` (Cognito)

## Secrets and parameters

SSM parameters used by CDK:
- `/remote-swe/slack/bot-token`
- `/remote-swe/slack/signing-secret`
- `/remote-swe/github/app-private-key`
- `/remote-swe/worker/ami-id` (managed by image builder pipeline)

## Deploy / upgrade

1) Update repo:
```bash
cd /Users/nwparker/projects/remote-swe-agents
git pull
```

2) Ensure `cdk/.env.local` is set:
```
GITHUB_APP_ID=2590194
GITHUB_INSTALLATION_ID=102511651
INITIAL_WEBAPP_USER_EMAIL=neil@stably.ai
TARGET_ENV=Sandbox
VPC_ID=vpc-04b8a451ecea42e4e
```

3) Deploy:
```bash
cd /Users/nwparker/projects/remote-swe-agents/cdk
AWS_PROFILE=default AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 npm ci
AWS_PROFILE=default AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 npx cdk deploy --all
```

## Slack app setup / rotation

Manifest file used for the Slack app:
- `resources/slack-app-manifest-s0.json`

If the Slack endpoint changes:
1) Regenerate the manifest with the new `SlackBoltEndpointUrl`.
2) Reinstall the app in Slack (OAuth & Permissions).
3) Update SSM parameters and re-deploy:
```bash
aws ssm put-parameter \
  --name /remote-swe/slack/bot-token \
  --value "xoxb-..." \
  --type String \
  --overwrite \
  --region us-west-2 \
  --profile default

aws ssm put-parameter \
  --name /remote-swe/slack/signing-secret \
  --value "..." \
  --type String \
  --overwrite \
  --region us-west-2 \
  --profile default

cd /Users/nwparker/projects/remote-swe-agents/cdk
AWS_PROFILE=default AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 npx cdk deploy --all
```

## GitHub App key rotation

```bash
aws ssm put-parameter \
  --name /remote-swe/github/app-private-key \
  --value "$(cat /path/to/new-private-key.pem)" \
  --type String \
  --overwrite \
  --region us-west-2 \
  --profile default

cd /Users/nwparker/projects/remote-swe-agents/cdk
AWS_PROFILE=default AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 npx cdk deploy --all
```

## Cognito users

- Self sign-up is disabled.
- Users are created in the Cognito console (User Pool from stack outputs) or via the initial email.
- Password policy requires uppercase, symbols, digits, min length 8.

To add or disable users: AWS Console -> Cognito -> User Pools -> Users.

CLI invite example:
```bash
USER_POOL_ID=$(aws cloudformation describe-stacks \
  --stack-name RemoteSweStack-Sandbox \
  --region us-west-2 \
  --profile default \
  --query "Stacks[0].Outputs[?OutputKey=='AuthUserPoolIdC0605E59'].OutputValue | [0]" \
  --output text)

aws cognito-idp admin-create-user \
  --user-pool-id "$USER_POOL_ID" \
  --username "person@stably.ai" \
  --user-attributes Name=email,Value="person@stably.ai" Name=email_verified,Value=true \
  --desired-delivery-mediums EMAIL \
  --region us-west-2 \
  --profile default
```

Bulk invite:
```bash
USER_POOL_ID=$(aws cloudformation describe-stacks \
  --stack-name RemoteSweStack-Sandbox \
  --region us-west-2 \
  --profile default \
  --query "Stacks[0].Outputs[?OutputKey=='AuthUserPoolIdC0605E59'].OutputValue | [0]" \
  --output text)

for email in user1@stably.ai user2@stably.ai; do
  aws cognito-idp admin-create-user \
    --user-pool-id "$USER_POOL_ID" \
    --username "$email" \
    --user-attributes Name=email,Value="$email" Name=email_verified,Value=true \
    --desired-delivery-mediums EMAIL \
    --region us-west-2 \
    --profile default
done
```

## Teardown

```bash
cd /Users/nwparker/projects/remote-swe-agents/cdk
AWS_PROFILE=default AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 npx cdk destroy --force
```

Note: an EC2 Image Builder pipeline runs asynchronously during deploy. Wait ~30 minutes after deployment before destroy; retry if deletion fails.

## Troubleshooting

- VPC/IGW limits: the account hit limits, so the stack uses `VPC_ID=vpc-04b8a451ecea42e4e`.
- If CDK is blocked by stack rollback: wait for rollback to complete, then rerun deploy.
- If Slack stops responding: verify `SlackBoltEndpointUrl`, reinstall app, update SSM, redeploy.

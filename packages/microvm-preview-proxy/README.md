# MicroVM Preview Proxy

A lightweight tunnel proxy that runs inside a Lambda MicroVM, bridging browser HTTP/WS traffic to the AgentCore worker's dev server via a WebSocket tunnel.

## Architecture

```
Browser → CloudFront (L@E auth) → MicroVM:8080 (this proxy) → WS tunnel → Worker:devPort
```

## Deployment

The MicroVM image is managed automatically by the CDK stack via the `LambdaMicrovmImage` L2 construct. When this package's source changes, `cdk deploy` will:

1. Zip the source directory as a CDK asset and upload to S3
2. Create/update the `AWS::Lambda::MicrovmImage` CloudFormation resource
3. Pass the image ARN to the worker environment as a CloudFormation token reference

No manual image creation steps are required.

## Local Development

```bash
npm install
npm run build
npm start
```

The proxy listens on:
- Port 8080: HTTP/WS proxy for browser traffic
- Port 9000: WebSocket tunnel endpoint for the worker connection

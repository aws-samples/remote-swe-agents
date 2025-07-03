# Worker

This is the agent implementation that works in its own EC2 environment.

## Run locally

You can run the agent locally using the below command. Note that you must provide `BUCKET_NAME` and `TABLE_NAME` using the actual ARN. 

```sh
cd packages/common
npm run watch
```

```sh
cd packages/worker
npm run setup:local
npm run start:local

# access http://localhost:8001 for DynamoDB Admin
```

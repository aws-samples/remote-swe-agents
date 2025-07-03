# Worker

This is the agent implementation that works in its own EC2 environment.

## Run locally

You can run the agent locally using the below command. Note that you must provide `BUCKET_NAME` and `TABLE_NAME` using the actual ARN. 

```sh
cd packages/common
npm run watch
```

```sh
export BUCKET_NAME=remoteswestack-sandbox-storageimagebucket99ba9550-xxxxxxx
export TABLE_NAME=RemoteSweStack-Sandbox-StorageHistory251A3AE8-xxxxxxx
export GITHUB_PERSONAL_ACCESS_TOKEN='dummy'
npx tsx src/local.ts
```

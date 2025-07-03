# ローカル開発環境セットアップガイド

このガイドでは、Remote SWE Agentsをローカル環境で開発およびテストするための手順を説明します。特にDynamoDB Localを使用して、AWSアカウントに依存せずに完全なローカル開発環境を設定する方法を紹介します。

## 前提条件

- Node.js (v18以上)
- Docker および Docker Compose
- Git
- OpenAI API キー（ローカルでのエージェント実行に必要）

## セットアップ手順

### 1. リポジトリのクローン

```bash
git clone https://github.com/aws-samples/remote-swe-agents.git
cd remote-swe-agents
```

### 2. 依存関係のインストール

```bash
npm ci
```

### 3. 環境変数の設定

`.env.local.example`ファイルを`.env.local`としてコピーし、必要な環境変数を設定します：

```bash
cp .env.local.example .env.local
```

`.env.local`を編集して、少なくとも以下の値を設定してください：

```
# DynamoDB Local設定はデフォルト値のままで問題ありません
DYNAMODB_ENDPOINT=http://localhost:8000
TABLE_NAME=RemoteSWEAgentsTable-local
AWS_REGION=ap-northeast-1

# ローカル開発用のAWS認証情報（DynamoDB Localでは任意の値で構いません）
AWS_ACCESS_KEY_ID=local
AWS_SECRET_ACCESS_KEY=local

# Workerの設定
WORKER_ID=local-worker

# OpenAI API設定（実際のAPIキーを設定してください）
OPENAI_API_KEY=your_openai_api_key
```

### 4. DynamoDB LocalとWorkerの起動

提供されているスクリプトを使用して、DynamoDB Localの起動とテーブルの作成、そしてworkerの起動を一度に行うことができます：

```bash
./scripts/start-local.sh
```

このスクリプトは以下の処理を行います：

1. `.env.local`から環境変数を読み込む
2. Docker Composeを使用してDynamoDB LocalとDynamoDB Adminを起動
3. DynamoDB Localにテーブルを作成
4. agent-coreモジュールをビルド
5. ローカルworkerを起動

### 5. 個別のコンポーネント起動（オプション）

個別にコンポーネントを起動したい場合は、以下のコマンドを実行してください：

#### DynamoDB LocalとDynamoDB Adminの起動

```bash
docker-compose up -d dynamodb-local dynamodb-admin
```

DynamoDB Adminは`http://localhost:8001`でアクセスできます。

#### テーブルの作成

```bash
node scripts/setup-dynamodb-local.js
```

#### agent-coreのビルド

```bash
npm run build -w @remote-swe-agents/agent-core
```

#### workerの起動

```bash
cd packages/worker && npm run start:local
```

## 使用方法

ローカルworkerが起動すると、コマンドラインインターフェースを通じてエージェントと対話できます。プロンプトに従ってメッセージを入力してください。

## DynamoDBデータの確認

DynamoDB Adminインターフェース（`http://localhost:8001`）を使用して、テーブル内のデータを確認および操作できます。

## トラブルシューティング

### DynamoDB Localに接続できない

- Docker Composeが正常に実行されているか確認してください
- `docker ps`コマンドで`dynamodb-local`コンテナが実行中か確認
- ポート8000が他のアプリケーションで使用されていないか確認

### テーブル作成エラー

- DynamoDB Localが起動しているか確認
- 環境変数`DYNAMODB_ENDPOINT`が正しく設定されているか確認

### Workerが起動しない

- agent-coreモジュールが正しくビルドされているか確認
- 環境変数が正しく設定されているか確認（特に`TABLE_NAME`と`OPENAI_API_KEY`）

## リソース

- [DynamoDB Local公式ドキュメント](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.html)
- [Remote SWE Agentsドキュメント](https://github.com/aws-samples/remote-swe-agents)
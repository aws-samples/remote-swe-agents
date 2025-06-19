import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TableName } from '@remote-swe-agents/agent-core/aws';
import NewSessionClient from './page.client';

interface PromptTemplate {
  SK: string;
  title: string;
  content: string;
  createdAt: number;
}

export default async function NewSessionPage() {
  // DynamoDBからテンプレート一覧を取得
  const { Items = [] } = await ddb.send(
    new QueryCommand({
      TableName,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: {
        ':pk': 'prompt-template',
      },
      ScanIndexForward: false, // createdAt DESC
    })
  );

  const templates = Items as PromptTemplate[];

  return <NewSessionClient templates={templates} />;
}

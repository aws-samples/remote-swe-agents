import { reportProgressTool } from '../tools/report-progress';
import { PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TableName } from './aws/ddb';

export const renderToolResult = (props: { toolResult: string; forceReport: boolean }) => {
  return `
<result>
${props.toolResult}
</result>
<command>
${props.forceReport ? `Long time has passed since you sent the last message. Please use ${reportProgressTool.name} tool to send a response asap.` : ''}
</command>
`.trim();
};

export const renderUserMessage = (props: { message: string }) => {
  return `
<user_message>
${props.message}
</user_message>
<command>
User sent you a message. Please use ${reportProgressTool.name} tool to send a response asap.
</command>
`.trim();
};

/**
 * Global config keys for DynamoDB
 */
export const GlobalConfigKeys = {
  PK: 'global-config',
  PromptSK: 'prompt',
};

/**
 * Type definition for common prompt data
 */
export interface CommonPromptData {
  additionalSystemPrompt: string;
}

/**
 * Read the common prompt from DynamoDB
 * @returns Promise with the common prompt data or null if not found
 */
export const readCommonPrompt = async (): Promise<CommonPromptData | null> => {
  try {
    const result = await ddb.send(
      new GetCommand({
        TableName,
        Key: {
          PK: GlobalConfigKeys.PK,
          SK: GlobalConfigKeys.PromptSK,
        },
      })
    );

    if (!result.Item) {
      return null;
    }

    return {
      additionalSystemPrompt: result.Item.additionalSystemPrompt || '',
    };
  } catch (error) {
    console.error('Error reading common prompt:', error);
    return null;
  }
};

/**
 * Write the common prompt to DynamoDB
 * @param data The common prompt data to write
 * @returns Promise that resolves when the data is written
 */
export const writeCommonPrompt = async (data: CommonPromptData): Promise<void> => {
  await ddb.send(
    new PutCommand({
      TableName,
      Item: {
        PK: GlobalConfigKeys.PK,
        SK: GlobalConfigKeys.PromptSK,
        additionalSystemPrompt: data.additionalSystemPrompt,
      },
    })
  );
};

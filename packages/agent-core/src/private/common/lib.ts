import { Tool, ToolInputSchema, ToolResultContentBlock } from '@aws-sdk/client-bedrock-runtime';
import { ZodSchema, z } from 'zod';

export type ToolDefinition<Input> = {
  /**
   * Name of the tool. This is the identifier of the tool for the agent.
   */
  readonly name: string;
  readonly handler: (input: Input, context: { toolUseId: string }) => Promise<string | ToolResultContentBlock[]>;
  readonly schema: ZodSchema;
  readonly toolSpec: () => Promise<NonNullable<Tool['toolSpec']>>;
};

/**
 * Converts a Zod schema to a JSON schema compatible with Bedrock's ToolInputSchema
 * @param schema Zod schema to convert
 * @returns JSON schema
 */
export const zodToJsonSchemaBody = (schema: ZodSchema): any => {
  const jsonSchema = z.toJSONSchema(schema, { 
    target: "draft-2020-12",
    unrepresentable: "any" 
  });
  
  // Return the JSON schema as a raw object that can be assigned to the json property
  // This will be used in toolSpec implementations as { json: zodToJsonSchemaBody(schema) }
  return jsonSchema;
};

export const truncate = (str: string, maxLength: number = 10 * 1e3, headRatio = 0.2) => {
  if (str.length < maxLength) return str;
  if (headRatio < 0 || headRatio > 1) throw new Error('headRatio must be between 0 and 1');

  const first = str.slice(0, maxLength * headRatio);
  const last = str.slice(-maxLength * (1 - headRatio));
  return first + '\n..(truncated)..\n' + last + `\n// Output was truncated. Original length: ${str.length} characters.`;
};

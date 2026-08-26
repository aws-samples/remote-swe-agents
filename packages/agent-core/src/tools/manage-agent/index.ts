import { z } from 'zod';
import { ToolDefinition, zodToJsonSchemaBody } from '../../private/common/lib';
import {
  getCustomAgents,
  getCustomAgent,
  createCustomAgent,
  updateCustomAgent,
  deleteCustomAgent,
} from '../../lib/custom-agent';
import { modelTypeSchema, runtimeTypeSchema, inferenceModeSchema, kiroModelSchema } from '../../schema';
import { savePendingCreateAgent } from '../confirm-create-agent';

const agentFieldsSchema = z.object({
  name: z.string().describe('The name of the agent.'),
  description: z.string().default('').describe('A description of the agent.'),
  defaultModel: modelTypeSchema.describe('The default model to use for this agent.'),
  bedrockDefaultModel: modelTypeSchema
    .optional()
    .describe('The Bedrock model for this agent. Takes priority over defaultModel (legacy).'),
  kiroDefaultModel: kiroModelSchema
    .optional()
    .describe("The Kiro model for this agent. Takes priority over kiroModel (legacy). Omit to use 'auto'."),
  systemPrompt: z.string().describe('The system prompt that defines the agent behavior.'),
  tools: z
    .array(z.string())
    .describe(
      'List of tool names the agent can use. Use the "listAgents" tool first to see available tool names from existing agents.'
    ),
  useAllTools: z
    .boolean()
    .default(false)
    .describe('Whether to use all available tools. When true, the tools array is ignored.'),
  mcpConfig: z
    .string()
    .default('{"mcpServers":{}}')
    .describe('MCP server configuration as JSON string. Default: {"mcpServers":{}}'),
  runtimeType: runtimeTypeSchema.describe('The runtime type for the agent: "ec2" or "agent-core".'),
  includeDefaultKnowledge: z
    .boolean()
    .default(true)
    .describe(
      'Whether to include default SWE knowledge (communication style, Git workflow, coding conventions) in the system prompt. Only relevant when a custom systemPrompt is provided. Default: true.'
    ),
  parentAgentId: z
    .string()
    .optional()
    .describe(
      'Optional ID of the parent agent. When set, this agent is treated as a sub-agent of the specified parent and is hidden from top-level agent selection UIs. Leave unset for standalone agents.'
    ),
  inferenceMode: inferenceModeSchema
    .optional()
    .describe(
      "Inference mode for sessions using this agent. 'kiro-cli': use Kiro CLI inference (no Bedrock cost). 'bedrock': use Bedrock direct inference. Omit to fall through to env / default."
    ),
  kiroModel: kiroModelSchema
    .optional()
    .describe("Model to use when inferenceMode is 'kiro-cli'. Omit to use the default (auto)."),
});

const listAgentsSchema = z.object({});
const getAgentSchema = z.object({
  agentId: z.string().describe('The ID (SK) of the agent to retrieve.'),
});
const createAgentSchema = agentFieldsSchema;
const updateAgentSchema = z.object({
  agentId: z.string().describe('The ID (SK) of the agent to update.'),
  name: z.string().optional().describe('The name of the agent.'),
  description: z.string().optional().describe('A description of the agent.'),
  defaultModel: modelTypeSchema.optional().describe('The default model to use for this agent.'),
  bedrockDefaultModel: modelTypeSchema
    .optional()
    .describe('The Bedrock model for this agent. Takes priority over defaultModel (legacy).'),
  kiroDefaultModel: kiroModelSchema
    .optional()
    .describe("The Kiro model for this agent. Takes priority over kiroModel (legacy). Omit to use 'auto'."),
  systemPrompt: z.string().optional().describe('The system prompt that defines the agent behavior.'),
  tools: z
    .array(z.string())
    .optional()
    .describe(
      'List of tool names the agent can use. Use the "listAgents" tool first to see available tool names from existing agents.'
    ),
  useAllTools: z
    .boolean()
    .optional()
    .describe('Whether to use all available tools. When true, the tools array is ignored.'),
  mcpConfig: z.string().optional().describe('MCP server configuration as JSON string.'),
  runtimeType: runtimeTypeSchema.optional().describe('The runtime type for the agent: "ec2" or "agent-core".'),
  includeDefaultKnowledge: z
    .boolean()
    .optional()
    .describe(
      'Whether to include default SWE knowledge (communication style, Git workflow, coding conventions) in the system prompt.'
    ),
  parentAgentId: z
    .string()
    .optional()
    .describe(
      'Optional ID of the parent agent. When set, this agent is treated as a sub-agent of the specified parent and is hidden from top-level agent selection UIs.'
    ),
  inferenceMode: inferenceModeSchema
    .optional()
    .describe(
      "Inference mode for sessions using this agent. 'kiro-cli': use Kiro CLI inference (no Bedrock cost). 'bedrock': use Bedrock direct inference. Omit to fall through to env / default."
    ),
  kiroModel: kiroModelSchema
    .optional()
    .describe("Model to use when inferenceMode is 'kiro-cli'. Omit to use the default (auto)."),
});
const deleteAgentSchema = z.object({
  agentId: z.string().describe('The ID (SK) of the agent to delete.'),
});

const agentManagementDescription = `Manage custom agents: list, get, create, update, or delete agent configurations.

## When to use:
- When the user asks you to create, modify, or manage agent configurations
- When you need to inspect existing agents to understand their setup
- For self-improvement: update your own agent configuration
- After making mistakes or discovering better approaches, update the agent to prevent similar issues

## Tips:
- Use "listAgents" first to discover existing agents and their IDs
- Use "getAgent" to retrieve the full configuration before making updates
- "updateAgent" supports partial updates: only fields you specify are changed; omitted fields keep their existing values
- The tools array should contain tool name strings; check existing agents for valid tool names`;

export const listAgentsTool: ToolDefinition<z.infer<typeof listAgentsSchema>> = {
  name: 'listAgents',
  handler: async () => {
    const agents = await getCustomAgents();
    if (agents.length === 0) {
      return 'No custom agents found.';
    }
    const summary = agents.map((a) => ({
      id: a.SK,
      name: a.name,
      description: a.description,
      defaultModel: a.defaultModel,
      bedrockDefaultModel: a.bedrockDefaultModel,
      kiroDefaultModel: a.kiroDefaultModel,
      runtimeType: a.runtimeType,
      tools: a.tools,
      parentAgentId: a.parentAgentId,
      createdAt: new Date(a.createdAt).toISOString(),
      updatedAt: new Date(a.updatedAt).toISOString(),
    }));
    return JSON.stringify(summary, null, 2);
  },
  schema: listAgentsSchema,
  toolSpec: async () => ({
    name: 'listAgents',
    description: `List all custom agents. Returns id, name, description, model, runtime, and tools for each agent.\n\n${agentManagementDescription}`,
    inputSchema: { json: zodToJsonSchemaBody(listAgentsSchema) },
  }),
};

export const getAgentTool: ToolDefinition<z.infer<typeof getAgentSchema>> = {
  name: 'getAgent',
  handler: async (input) => {
    const agent = await getCustomAgent(input.agentId);
    if (!agent) {
      return `Agent with ID "${input.agentId}" not found.`;
    }
    return JSON.stringify(
      {
        id: agent.SK,
        name: agent.name,
        description: agent.description,
        defaultModel: agent.defaultModel,
        bedrockDefaultModel: agent.bedrockDefaultModel,
        kiroDefaultModel: agent.kiroDefaultModel,
        systemPrompt: agent.systemPrompt,
        tools: agent.tools,
        mcpConfig: agent.mcpConfig,
        runtimeType: agent.runtimeType,
        includeDefaultKnowledge: agent.includeDefaultKnowledge !== false,
        inferenceMode: agent.inferenceMode,
        kiroModel: agent.kiroModel,
        parentAgentId: agent.parentAgentId,
        createdAt: new Date(agent.createdAt).toISOString(),
        updatedAt: new Date(agent.updatedAt).toISOString(),
      },
      null,
      2
    );
  },
  schema: getAgentSchema,
  toolSpec: async () => ({
    name: 'getAgent',
    description: `Get full details of a specific agent including system prompt and MCP config.\n\n${agentManagementDescription}`,
    inputSchema: { json: zodToJsonSchemaBody(getAgentSchema) },
  }),
};

export const createAgentTool: ToolDefinition<z.infer<typeof createAgentSchema>> = {
  name: 'createAgent',
  handler: async (input, context) => {
    if (input.parentAgentId) {
      const parent = await getCustomAgent(input.parentAgentId);
      if (!parent) {
        return `Error: parentAgentId '${input.parentAgentId}' does not exist.`;
      }
    }
    const agentData = {
      name: input.name,
      description: input.description ?? '',
      defaultModel: input.bedrockDefaultModel ?? input.defaultModel,
      bedrockDefaultModel: input.bedrockDefaultModel ?? input.defaultModel,
      kiroDefaultModel: input.kiroDefaultModel ?? input.kiroModel,
      systemPrompt: input.systemPrompt,
      tools: input.tools,
      useAllTools: input.useAllTools ?? false,
      mcpConfig: input.mcpConfig ?? '{"mcpServers":{}}',
      runtimeType: input.runtimeType,
      includeDefaultKnowledge: input.includeDefaultKnowledge ?? true,
      parentAgentId: input.parentAgentId,
      inferenceMode: input.inferenceMode,
      kiroModel: input.kiroDefaultModel ?? input.kiroModel,
    };

    if (!input.parentAgentId) {
      savePendingCreateAgent(context.workerId, agentData);
      return [
        `CONFIRMATION REQUIRED: You are about to create a new top-level agent "${input.name}".`,
        ``,
        `Top-level agent creation requires explicit user approval.`,
        `Please ask the user whether they approve creating this agent, and only call confirmCreateAgent after receiving explicit approval.`,
        ``,
        `To proceed: get user approval, then call confirmCreateAgent.`,
        `To abort: simply do not call confirmCreateAgent.`,
      ].join('\n');
    }

    const agent = await createCustomAgent(agentData);
    if (agent.parentAgentId && agent.parentAgentId === agent.SK) {
      await deleteCustomAgent(agent.SK);
      return `Error: parentAgentId cannot reference itself.`;
    }
    const parentLine = agent.parentAgentId ? `\n- Parent Agent ID: ${agent.parentAgentId}` : '';
    return `Agent created successfully.\n- ID: ${agent.SK}\n- Name: ${agent.name}${parentLine}`;
  },
  schema: createAgentSchema,
  toolSpec: async () => ({
    name: 'createAgent',
    description: `Create a new custom agent with all configuration fields. Top-level agent creation (parentAgentId not specified) requires user approval and a subsequent call to confirmCreateAgent.\n\n${agentManagementDescription}`,
    inputSchema: { json: zodToJsonSchemaBody(createAgentSchema) },
  }),
};

export const updateAgentTool: ToolDefinition<z.infer<typeof updateAgentSchema>> = {
  name: 'updateAgent',
  handler: async (input) => {
    const existing = await getCustomAgent(input.agentId);
    if (!existing) {
      return `Agent with ID "${input.agentId}" not found.`;
    }
    if (input.parentAgentId !== undefined && input.parentAgentId !== '') {
      if (input.parentAgentId === input.agentId) {
        return `Error: parentAgentId cannot reference itself.`;
      }
      const parent = await getCustomAgent(input.parentAgentId);
      if (!parent) {
        return `Error: parentAgentId '${input.parentAgentId}' does not exist.`;
      }
    }
    const { agentId, ...rest } = input;
    const updates: Record<string, unknown> = { ...rest };
    // Keep legacy `defaultModel` in sync when `bedrockDefaultModel` is updated
    if (input.bedrockDefaultModel !== undefined) {
      updates.defaultModel = input.bedrockDefaultModel;
    }
    // Keep legacy `kiroModel` in sync when `kiroDefaultModel` is updated
    if (input.kiroDefaultModel !== undefined) {
      updates.kiroModel = input.kiroDefaultModel;
    }
    // Reverse sync: when legacy fields are updated without new fields, propagate
    // to new fields so the resolver (which prefers new fields) picks up the change.
    if (input.defaultModel !== undefined && input.bedrockDefaultModel === undefined) {
      updates.bedrockDefaultModel = input.defaultModel;
    }
    if (input.kiroModel !== undefined && input.kiroDefaultModel === undefined) {
      updates.kiroDefaultModel = input.kiroModel;
    }
    const agent = await updateCustomAgent(agentId, updates);
    return `Agent updated successfully.\n- ID: ${agent.SK}\n- Name: ${agent.name}`;
  },
  schema: updateAgentSchema,
  toolSpec: async () => ({
    name: 'updateAgent',
    description: `Update an existing agent's configuration. Supports partial updates: only fields you specify are changed; omitted fields keep their existing values.\n\n${agentManagementDescription}`,
    inputSchema: { json: zodToJsonSchemaBody(updateAgentSchema) },
  }),
};

export const deleteAgentTool: ToolDefinition<z.infer<typeof deleteAgentSchema>> = {
  name: 'deleteAgent',
  handler: async (input) => {
    const existing = await getCustomAgent(input.agentId);
    if (!existing) {
      return `Agent with ID "${input.agentId}" not found.`;
    }
    await deleteCustomAgent(input.agentId);
    return `Agent "${existing.name}" (ID: ${input.agentId}) deleted successfully.`;
  },
  schema: deleteAgentSchema,
  toolSpec: async () => ({
    name: 'deleteAgent',
    description: `Delete a custom agent by ID.\n\n${agentManagementDescription}`,
    inputSchema: { json: zodToJsonSchemaBody(deleteAgentSchema) },
  }),
};

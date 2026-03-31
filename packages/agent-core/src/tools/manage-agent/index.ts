import { z } from 'zod';
import { ToolDefinition, zodToJsonSchemaBody } from '../../private/common/lib';
import {
  getCustomAgents,
  getCustomAgent,
  createCustomAgent,
  updateCustomAgent,
  deleteCustomAgent,
} from '../../lib/custom-agent';
import { modelTypeSchema, runtimeTypeSchema } from '../../schema';

const agentFieldsSchema = z.object({
  name: z.string().describe('The name of the agent.'),
  description: z.string().default('').describe('A description of the agent.'),
  defaultModel: modelTypeSchema.describe('The default model to use for this agent.'),
  systemPrompt: z.string().describe('The system prompt that defines the agent behavior.'),
  tools: z
    .array(z.string())
    .describe(
      'List of tool names the agent can use. Use the "listAgents" tool first to see available tool names from existing agents.'
    ),
  mcpConfig: z
    .string()
    .default('{"mcpServers":{}}')
    .describe('MCP server configuration as JSON string. Default: {"mcpServers":{}}'),
  runtimeType: runtimeTypeSchema.describe('The runtime type for the agent: "ec2" or "agent-core".'),
});

const listAgentsSchema = z.object({});
const getAgentSchema = z.object({
  agentId: z.string().describe('The ID (SK) of the agent to retrieve.'),
});
const createAgentSchema = agentFieldsSchema;
const updateAgentSchema = z
  .object({
    agentId: z.string().describe('The ID (SK) of the agent to update.'),
  })
  .merge(agentFieldsSchema);
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
- When updating, provide all fields (not just the changed ones) to avoid accidentally clearing settings
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
      runtimeType: a.runtimeType,
      tools: a.tools,
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
        systemPrompt: agent.systemPrompt,
        tools: agent.tools,
        mcpConfig: agent.mcpConfig,
        runtimeType: agent.runtimeType,
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
  handler: async (input) => {
    const agentData = {
      name: input.name,
      description: input.description ?? '',
      defaultModel: input.defaultModel,
      systemPrompt: input.systemPrompt,
      tools: input.tools,
      mcpConfig: input.mcpConfig ?? '{"mcpServers":{}}',
      runtimeType: input.runtimeType,
    };
    const agent = await createCustomAgent(agentData);
    return `Agent created successfully.\n- ID: ${agent.SK}\n- Name: ${agent.name}`;
  },
  schema: createAgentSchema,
  toolSpec: async () => ({
    name: 'createAgent',
    description: `Create a new custom agent with all configuration fields.\n\n${agentManagementDescription}`,
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
    const agentData = {
      name: input.name,
      description: input.description ?? '',
      defaultModel: input.defaultModel,
      systemPrompt: input.systemPrompt,
      tools: input.tools,
      mcpConfig: input.mcpConfig ?? '{"mcpServers":{}}',
      runtimeType: input.runtimeType,
    };
    const agent = await updateCustomAgent(input.agentId, agentData);
    return `Agent updated successfully.\n- ID: ${agent.SK}\n- Name: ${agent.name}`;
  },
  schema: updateAgentSchema,
  toolSpec: async () => ({
    name: 'updateAgent',
    description: `Update an existing agent's configuration. All fields are required to avoid accidentally clearing settings.\n\n${agentManagementDescription}`,
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

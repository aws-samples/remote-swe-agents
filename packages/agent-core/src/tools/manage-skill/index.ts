import { z } from 'zod';
import { ToolDefinition, zodToJsonSchemaBody } from '../../private/common/lib';
import {
  listSkills,
  getSkill,
  registerSkillFromFiles,
  updateSkillFromFiles,
  deleteSkillRecord,
} from '../../lib/skills';
import { deleteSkillFiles } from '../../lib/skill-s3';
import { getSession } from '../../lib/sessions';
import { SKILL_NAME_PATTERN, MAX_SKILL_NAME_LENGTH } from '../../schema/skill';

const resolveUserId = async (workerId: string): Promise<string> => {
  const session = await getSession(workerId);
  if (!session?.initiator) {
    throw new Error('Could not determine user identity from session.');
  }
  return session.initiator.includes('#') ? session.initiator.split('#').pop()! : session.initiator;
};

const skillFileSchema = z
  .object({
    path: z.string().describe('Relative path of the supporting file (e.g. "references/guide.md").'),
    content: z
      .string()
      .optional()
      .describe('Text content of the file. Exactly one of content or s3Uri must be provided.'),
    s3Uri: z
      .string()
      .optional()
      .describe(
        'S3 URI (s3://bucket/key) to copy the file content from. Use this for binary or large files instead of content. Allowed sources: the session artifact bucket (upload staged files there first), or your own skill prefix in the skill bucket. Exactly one of content or s3Uri must be provided.'
      ),
  })
  .refine((f) => (f.content !== undefined) !== (f.s3Uri !== undefined), {
    message: 'Exactly one of content or s3Uri must be provided',
  });

const skillManagementDescription = `Manage user skills: list, get, create, update, or delete skill packages.

Skills are reusable prompt fragments that extend agent capabilities. Each skill has a SKILL.md with YAML frontmatter (name, description, allowed-tools) and an optional set of supporting files.

IMPORTANT: Creating or updating a skill affects ALL future sessions for this user. Always confirm with the user before making changes.`;

const listSkillsSchema = z.object({});
const getSkillSchema = z.object({
  skillId: z.string().describe('The ID of the skill to retrieve.'),
});
const createSkillSchema = z.object({
  skillMd: z
    .string()
    .describe(
      'Full content of SKILL.md including YAML frontmatter (---\\nname: ...\\ndescription: ...\\n---\\n<body>).'
    ),
  files: z.array(skillFileSchema).optional().describe('Optional supporting files to include in the skill package.'),
});
const updateSkillSchema = z.object({
  skillId: z.string().describe('The ID of the skill to update.'),
  skillMd: z
    .string()
    .optional()
    .describe(
      'Full content of the updated SKILL.md including YAML frontmatter (---\\nname: ...\\ndescription: ...\\n---\\n<body>). Required unless keepExistingFiles is true, in which case the existing SKILL.md is preserved when omitted.'
    ),
  files: z
    .array(skillFileSchema)
    .optional()
    .describe(
      'Optional supporting files. By default this replaces ALL existing files; set keepExistingFiles to true to only replace/add the listed files.'
    ),
  keepExistingFiles: z
    .boolean()
    .optional()
    .describe(
      'When true, only the provided files are replaced or added and all other existing files are kept (partial update). Default: false (full replacement).'
    ),
});
const deleteSkillSchema = z.object({
  skillId: z.string().describe('The ID of the skill to delete.'),
});

export const listSkillsTool: ToolDefinition<z.infer<typeof listSkillsSchema>> = {
  name: 'listSkills',
  handler: async (_input, context) => {
    const userId = await resolveUserId(context.workerId);
    const skills = await listSkills(userId);
    if (skills.length === 0) return 'No skills found.';
    const summary = skills.map((s) => ({
      id: s.SK,
      name: s.name,
      description: s.description,
      fileCount: s.fileCount,
      totalSize: s.totalSize,
      createdAt: new Date(s.createdAt).toISOString(),
      updatedAt: new Date(s.updatedAt).toISOString(),
    }));
    return JSON.stringify(summary, null, 2);
  },
  schema: listSkillsSchema,
  toolSpec: async () => ({
    name: 'listSkills',
    description: `List all skills for the current user.\n\n${skillManagementDescription}`,
    inputSchema: { json: zodToJsonSchemaBody(listSkillsSchema) },
  }),
};

export const getSkillTool: ToolDefinition<z.infer<typeof getSkillSchema>> = {
  name: 'getSkill',
  handler: async (input, context) => {
    const userId = await resolveUserId(context.workerId);
    const skill = await getSkill(userId, input.skillId);
    if (!skill) return `Skill with ID "${input.skillId}" not found.`;
    return JSON.stringify(
      {
        id: skill.SK,
        name: skill.name,
        description: skill.description,
        allowedTools: skill.allowedTools,
        fileCount: skill.fileCount,
        totalSize: skill.totalSize,
        s3Prefix: skill.s3Prefix,
        createdAt: new Date(skill.createdAt).toISOString(),
        updatedAt: new Date(skill.updatedAt).toISOString(),
      },
      null,
      2
    );
  },
  schema: getSkillSchema,
  toolSpec: async () => ({
    name: 'getSkill',
    description: `Get details of a specific skill by ID.\n\n${skillManagementDescription}`,
    inputSchema: { json: zodToJsonSchemaBody(getSkillSchema) },
  }),
};

export const createSkillTool: ToolDefinition<z.infer<typeof createSkillSchema>> = {
  name: 'createSkill',
  handler: async (input, context) => {
    const userId = await resolveUserId(context.workerId);
    try {
      const skill = await registerSkillFromFiles(userId, { skillMd: input.skillMd, files: input.files });
      return `Skill created successfully.\n- ID: ${skill.SK}\n- Name: ${skill.name}`;
    } catch (e) {
      return `Error: ${(e as Error).message}`;
    }
  },
  schema: createSkillSchema,
  toolSpec: async () => ({
    name: 'createSkill',
    description: `Create a new skill from SKILL.md content and optional supporting files. Binary or large supporting files can be passed by S3 URI reference via files[].s3Uri.\n\n${skillManagementDescription}\n\nSKILL.md must have YAML frontmatter with required fields:\n- name: lowercase alphanumeric + hyphens, 1-${MAX_SKILL_NAME_LENGTH} chars, pattern: ${SKILL_NAME_PATTERN.source}\n- description: 1-1536 chars\n- allowed-tools (optional): array of tool names to restrict available tools when skill is active`,
    inputSchema: { json: zodToJsonSchemaBody(createSkillSchema) },
  }),
};

export const updateSkillTool: ToolDefinition<z.infer<typeof updateSkillSchema>> = {
  name: 'updateSkill',
  handler: async (input, context) => {
    const userId = await resolveUserId(context.workerId);
    try {
      const skill = await updateSkillFromFiles(userId, input.skillId, {
        skillMd: input.skillMd,
        files: input.files,
        keepExistingFiles: input.keepExistingFiles,
      });
      return `Skill updated successfully.\n- ID: ${skill.SK}\n- Name: ${skill.name}\n- Files: ${skill.fileCount}\n- Total size: ${skill.totalSize} bytes`;
    } catch (e) {
      return `Error: ${(e as Error).message}`;
    }
  },
  schema: updateSkillSchema,
  toolSpec: async () => ({
    name: 'updateSkill',
    description: `Update an existing skill in-place. The skill ID and S3 prefix are preserved (S3 versioning retains previous versions for rollback). By default all files are replaced by the provided set; pass keepExistingFiles=true for a partial update that keeps unlisted files. Binary or large files can be passed by S3 URI reference via files[].s3Uri.\n\n${skillManagementDescription}`,
    inputSchema: { json: zodToJsonSchemaBody(updateSkillSchema) },
  }),
};

export const deleteSkillTool: ToolDefinition<z.infer<typeof deleteSkillSchema>> = {
  name: 'deleteSkill',
  handler: async (input, context) => {
    const userId = await resolveUserId(context.workerId);
    const skill = await getSkill(userId, input.skillId);
    if (!skill) return `Skill with ID "${input.skillId}" not found.`;
    await deleteSkillRecord(userId, input.skillId);
    try {
      await deleteSkillFiles(skill.s3Prefix);
    } catch (error) {
      console.error('[deleteSkill] S3 cleanup failed (best-effort):', error);
    }
    return `Skill "${skill.name}" (ID: ${input.skillId}) deleted successfully.`;
  },
  schema: deleteSkillSchema,
  toolSpec: async () => ({
    name: 'deleteSkill',
    description: `Delete a skill by ID. Removes DDB record and S3 files (S3 versioning retains delete markers for recovery).\n\n${skillManagementDescription}`,
    inputSchema: { json: zodToJsonSchemaBody(deleteSkillSchema) },
  }),
};

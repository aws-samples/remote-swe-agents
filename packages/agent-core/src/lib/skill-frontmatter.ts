import yaml from 'js-yaml';
import { SKILL_NAME_PATTERN, MAX_SKILL_NAME_LENGTH, MAX_SKILL_DESCRIPTION_LENGTH } from '../schema/skill';

export interface SkillFrontmatter {
  name: string;
  description: string;
  allowedTools?: string[];
  kiroAgent?: string;
}

export interface ParseResult {
  frontmatter: SkillFrontmatter;
  body: string;
}

export const parseSkillMd = (content: string): ParseResult => {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    throw new Error('SKILL.md must have YAML frontmatter delimited by ---');
  }

  const [, rawYaml, body] = match;
  let parsed: Record<string, unknown>;
  try {
    parsed = yaml.load(rawYaml!) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`SKILL.md frontmatter is not valid YAML: ${(e as Error).message}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('SKILL.md frontmatter must be a YAML mapping');
  }

  const name = parsed.name;
  if (typeof name !== 'string' || !name) {
    throw new Error("SKILL.md frontmatter is missing required field 'name'");
  }
  if (name.length > MAX_SKILL_NAME_LENGTH) {
    throw new Error(`Skill name must be 1-${MAX_SKILL_NAME_LENGTH} characters`);
  }
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new Error('Skill name must match [a-z0-9-] and be 1-64 characters');
  }

  const description = parsed.description;
  if (typeof description !== 'string' || !description) {
    throw new Error("SKILL.md frontmatter is missing required field 'description'");
  }
  if (description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
    throw new Error(`Skill description must be at most ${MAX_SKILL_DESCRIPTION_LENGTH} characters`);
  }

  let allowedTools: string[] | undefined;
  const rawTools = parsed['allowed-tools'];
  if (rawTools !== undefined && rawTools !== null) {
    if (!Array.isArray(rawTools) || !rawTools.every((t) => typeof t === 'string')) {
      throw new Error("'allowed-tools' must be an array of strings");
    }
    allowedTools = rawTools as string[];
  }

  let kiroAgent: string | undefined;
  const rawKiroAgent = parsed['kiro-agent'];
  if (rawKiroAgent !== undefined && rawKiroAgent !== null) {
    if (typeof rawKiroAgent !== 'string' || !rawKiroAgent) {
      throw new Error("'kiro-agent' must be a non-empty string");
    }
    kiroAgent = rawKiroAgent;
  }

  return {
    frontmatter: { name, description, allowedTools, kiroAgent },
    body: body!,
  };
};

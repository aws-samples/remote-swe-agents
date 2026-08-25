import { describe, expect, test } from 'vitest';
import { parseSkillMd } from './skill-frontmatter';

describe('parseSkillMd', () => {
  test('parses valid frontmatter with all fields', () => {
    const content = `---
name: my-skill
description: A useful skill
allowed-tools:
  - read
  - write
---
# My Skill

This is the body.`;

    const result = parseSkillMd(content);
    expect(result.frontmatter.name).toBe('my-skill');
    expect(result.frontmatter.description).toBe('A useful skill');
    expect(result.frontmatter.allowedTools).toEqual(['read', 'write']);
    expect(result.body).toContain('# My Skill');
  });

  test('parses valid frontmatter without allowed-tools', () => {
    const content = `---
name: simple-skill
description: No tools restriction
---
Body content here.`;

    const result = parseSkillMd(content);
    expect(result.frontmatter.name).toBe('simple-skill');
    expect(result.frontmatter.description).toBe('No tools restriction');
    expect(result.frontmatter.allowedTools).toBeUndefined();
  });

  test('throws on missing frontmatter delimiters', () => {
    expect(() => parseSkillMd('# No frontmatter')).toThrow('must have YAML frontmatter');
  });

  test('throws on missing name', () => {
    const content = `---
description: Has description but no name
---
Body`;
    expect(() => parseSkillMd(content)).toThrow("missing required field 'name'");
  });

  test('throws on missing description', () => {
    const content = `---
name: has-name
---
Body`;
    expect(() => parseSkillMd(content)).toThrow("missing required field 'description'");
  });

  test('throws on invalid name format (uppercase)', () => {
    const content = `---
name: MySkill
description: Invalid name
---
Body`;
    expect(() => parseSkillMd(content)).toThrow('must match [a-z0-9-]');
  });

  test('throws on invalid name format (spaces)', () => {
    const content = `---
name: my skill
description: Invalid name
---
Body`;
    expect(() => parseSkillMd(content)).toThrow('must match [a-z0-9-]');
  });

  test('throws on name too long', () => {
    const content = `---
name: ${'a'.repeat(65)}
description: Too long name
---
Body`;
    expect(() => parseSkillMd(content)).toThrow('1-64 characters');
  });

  test('throws on invalid allowed-tools type', () => {
    const content = `---
name: bad-tools
description: Tools is not array
allowed-tools: just-a-string
---
Body`;
    expect(() => parseSkillMd(content)).toThrow("'allowed-tools' must be an array of strings");
  });

  test('throws on invalid YAML', () => {
    const content = `---
name: [invalid
description: bad yaml
---
Body`;
    expect(() => parseSkillMd(content)).toThrow('not valid YAML');
  });

  test('allows empty allowed-tools array', () => {
    const content = `---
name: no-tools
description: Empty tools means no tools beyond required
allowed-tools: []
---
Body`;

    const result = parseSkillMd(content);
    expect(result.frontmatter.allowedTools).toEqual([]);
  });

  test('description max length enforced', () => {
    const content = `---
name: long-desc
description: ${'x'.repeat(1537)}
---
Body`;
    expect(() => parseSkillMd(content)).toThrow('at most 1536 characters');
  });
});

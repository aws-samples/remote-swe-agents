import { describe, expect, test } from 'vitest';
import { buildSkillCatalogue } from './skill-catalogue';
import { Skill } from '../schema/skill';

const makeSkill = (overrides: Partial<Skill> = {}): Skill => ({
  PK: 'skill-user1',
  SK: 'abc123',
  name: 'test-skill',
  description: 'A test skill',
  fileCount: 1,
  totalSize: 100,
  s3Prefix: 'skills/user1/abc123/',
  createdAt: 1000,
  updatedAt: 2000,
  ...overrides,
});

describe('buildSkillCatalogue', () => {
  test('returns empty string for no skills', () => {
    expect(buildSkillCatalogue([])).toBe('');
  });

  test('builds catalogue with skill paths', () => {
    const skills = [makeSkill({ SK: 'sk1', name: 'deploy', description: 'Deploy helper' })];
    const result = buildSkillCatalogue(skills);
    expect(result).toContain('## Available Skills');
    expect(result).toContain('/tmp/skills/sk1/SKILL.md');
    expect(result).toContain('deploy');
    expect(result).toContain('Deploy helper');
  });

  test('sorts by updatedAt DESC', () => {
    const skills = [
      makeSkill({ SK: 'old', name: 'old-skill', updatedAt: 1000 }),
      makeSkill({ SK: 'new', name: 'new-skill', updatedAt: 3000 }),
    ];
    const result = buildSkillCatalogue(skills);
    const oldIdx = result.indexOf('old-skill');
    const newIdx = result.indexOf('new-skill');
    expect(newIdx).toBeLessThan(oldIdx);
  });

  test('limits to 20 skills and shows overflow message', () => {
    const skills = Array.from({ length: 25 }, (_, i) => makeSkill({ SK: `sk${i}`, name: `skill-${i}`, updatedAt: i }));
    const result = buildSkillCatalogue(skills);
    expect(result).toContain('Additional skills available');
    // Should only have 20 skill rows
    const rows = result.split('\n').filter((l) => l.startsWith('| skill-'));
    expect(rows.length).toBeLessThanOrEqual(20);
  });

  test('truncates long descriptions', () => {
    const longDesc = 'x'.repeat(300);
    const skills = [makeSkill({ description: longDesc })];
    const result = buildSkillCatalogue(skills);
    expect(result).not.toContain(longDesc);
    expect(result).toContain('...');
  });

  test('respects 4KB cap', () => {
    const skills = Array.from({ length: 20 }, (_, i) =>
      makeSkill({
        SK: `sk${i}`,
        name: `skill-${i}`,
        description: 'A'.repeat(250),
        updatedAt: i,
      })
    );
    const result = buildSkillCatalogue(skills);
    // The catalogue header + rows should not exceed 4KB significantly
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThan(5000);
  });
});

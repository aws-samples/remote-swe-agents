import { describe, expect, test, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();
const mockWriteBytesToKey = vi.fn();

vi.mock('../../lib/aws', () => ({
  ddb: { send: (...args: any[]) => mockSend(...args) },
  TableName: 'TestTable',
  s3: { send: (...args: any[]) => mockSend(...args) },
  BucketName: 'test-bucket',
  SkillBucketName: 'test-skill-bucket',
  writeBytesToKey: (...args: any[]) => mockWriteBytesToKey(...args),
}));

vi.mock('../../lib/sessions', () => ({
  getSession: vi.fn().mockResolvedValue({
    workerId: 'worker-1',
    initiator: 'cognito#user-123',
  }),
}));

import { listSkillsTool, getSkillTool, createSkillTool, updateSkillTool, deleteSkillTool } from './index';

const ctx = {
  workerId: 'worker-1',
  toolUseId: 'tu-1',
  globalPreferences: {},
} as any;

describe('manage-skill tool', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockWriteBytesToKey.mockReset();
  });

  test('listSkills returns skills summary', async () => {
    const items = [
      {
        PK: 'skill-user-123',
        SK: 'sk1',
        name: 'my-skill',
        description: 'desc',
        fileCount: 1,
        totalSize: 100,
        createdAt: 1000,
        updatedAt: 2000,
      },
    ];
    mockSend.mockResolvedValue({ Items: items });

    const result = await listSkillsTool.handler({}, ctx);
    expect(result).toContain('my-skill');
    expect(result).toContain('sk1');
  });

  test('listSkills returns message when empty', async () => {
    mockSend.mockResolvedValue({ Items: [] });
    const result = await listSkillsTool.handler({}, ctx);
    expect(result).toBe('No skills found.');
  });

  test('getSkill returns skill details', async () => {
    const skill = {
      PK: 'skill-user-123',
      SK: 'sk1',
      name: 'test-skill',
      description: 'desc',
      fileCount: 1,
      totalSize: 50,
      s3Prefix: 'skills/user-123/sk1',
      createdAt: 1000,
      updatedAt: 2000,
    };
    mockSend.mockResolvedValue({ Item: skill });

    const result = await getSkillTool.handler({ skillId: 'sk1' }, ctx);
    expect(result).toContain('test-skill');
    expect(result).toContain('sk1');
  });

  test('getSkill returns not found message', async () => {
    mockSend.mockResolvedValue({ Item: undefined });
    const result = await getSkillTool.handler({ skillId: 'nonexistent' }, ctx);
    expect(result).toContain('not found');
  });

  test('createSkill creates skill with valid SKILL.md', async () => {
    // listSkills returns empty (for storage check)
    mockSend.mockResolvedValueOnce({ Items: [] });
    // PutObjectCommand for SKILL.md
    mockSend.mockResolvedValueOnce({});
    // listSkills returns empty (for max check in createSkill)
    mockSend.mockResolvedValueOnce({ Items: [] });
    // createSkill PutCommand
    mockSend.mockResolvedValueOnce({});

    const skillMd = `---
name: my-new-skill
description: A great skill for testing
---
# My Skill

Instructions here.`;

    const result = await createSkillTool.handler({ skillMd }, ctx);
    expect(result).toContain('Skill created successfully');
    expect(result).toContain('my-new-skill');
  });

  test('createSkill returns error for invalid frontmatter', async () => {
    const skillMd = `No frontmatter here`;
    const result = await createSkillTool.handler({ skillMd }, ctx);
    expect(result).toContain('Error');
  });

  test('deleteSkill deletes existing skill', async () => {
    // getSkill
    mockSend.mockResolvedValueOnce({
      Item: { PK: 'skill-user-123', SK: 'sk1', name: 'test-skill', s3Prefix: 'skills/user-123/sk1' },
    });
    // deleteSkillRecord
    mockSend.mockResolvedValueOnce({});
    // deleteSkillFiles - ListObjectsV2
    mockSend.mockResolvedValueOnce({ Contents: [] });

    const result = await deleteSkillTool.handler({ skillId: 'sk1' }, ctx);
    expect(result).toContain('deleted successfully');
  });

  test('deleteSkill returns not found', async () => {
    mockSend.mockResolvedValueOnce({ Item: undefined });
    const result = await deleteSkillTool.handler({ skillId: 'nonexistent' }, ctx);
    expect(result).toContain('not found');
  });

  test('updateSkill updates existing skill in place', async () => {
    // getSkill for updateSkillFromFiles
    mockSend.mockResolvedValueOnce({
      Item: { PK: 'skill-user-123', SK: 'sk1', name: 'old-name', s3Prefix: 'skills/user-123/sk1', totalSize: 50 },
    });
    // listSkills for storage check
    mockSend.mockResolvedValueOnce({
      Items: [{ PK: 'skill-user-123', SK: 'sk1', totalSize: 50 }],
    });
    // ListObjectsV2 for old file cleanup
    mockSend.mockResolvedValueOnce({ Contents: [] });
    // PutObjectCommand for SKILL.md
    mockSend.mockResolvedValueOnce({});
    // UpdateCommand
    mockSend.mockResolvedValueOnce({
      Attributes: { PK: 'skill-user-123', SK: 'sk1', name: 'updated-skill' },
    });

    const skillMd = `---
name: updated-skill
description: Updated description
---
# Updated content`;

    const result = await updateSkillTool.handler({ skillId: 'sk1', skillMd }, ctx);
    expect(result).toContain('Skill updated successfully');
    expect(result).toContain('updated-skill');
  });

  test('updateSkill returns error for non-existent skill', async () => {
    mockSend.mockResolvedValueOnce({ Item: undefined });
    const result = await updateSkillTool.handler(
      { skillId: 'nonexistent', skillMd: '---\nname: x\ndescription: x\n---\nbody' },
      ctx
    );
    expect(result).toContain('Error');
    expect(result).toContain('SKILL_NOT_FOUND');
  });

  test('toolSpec names match tool names', async () => {
    expect((await listSkillsTool.toolSpec()).name).toBe('listSkills');
    expect((await getSkillTool.toolSpec()).name).toBe('getSkill');
    expect((await createSkillTool.toolSpec()).name).toBe('createSkill');
    expect((await updateSkillTool.toolSpec()).name).toBe('updateSkill');
    expect((await deleteSkillTool.toolSpec()).name).toBe('deleteSkill');
  });
});

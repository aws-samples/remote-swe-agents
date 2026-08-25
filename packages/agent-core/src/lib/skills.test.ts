import { describe, expect, test, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();

vi.mock('./aws', () => ({
  ddb: { send: (...args: any[]) => mockSend(...args) },
  TableName: 'TestTable',
  s3: { send: (...args: any[]) => mockSend(...args) },
  BucketName: 'test-bucket',
  SkillBucketName: 'test-skill-bucket',
}));

import {
  getSkill,
  listSkills,
  createSkill,
  deleteSkillRecord,
  registerSkillFromFiles,
  updateSkillFromFiles,
} from './skills';
import { MAX_SKILLS_PER_USER, MAX_SKILL_FILE_COUNT } from '../schema/skill';

describe('skills CRUD', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  test('getSkill returns item when found', async () => {
    const mockSkill = { PK: 'skill-user1', SK: 'abc123', name: 'test-skill' };
    mockSend.mockResolvedValue({ Item: mockSkill });

    const result = await getSkill('user1', 'abc123');
    expect(result).toEqual(mockSkill);

    const command = mockSend.mock.calls[0][0];
    expect(command.input.Key).toEqual({ PK: 'skill-user1', SK: 'abc123' });
  });

  test('getSkill returns undefined when not found', async () => {
    mockSend.mockResolvedValue({ Item: undefined });
    const result = await getSkill('user1', 'nonexistent');
    expect(result).toBeUndefined();
  });

  test('listSkills queries with correct PK', async () => {
    const mockItems = [
      { PK: 'skill-user1', SK: 'skill1', name: 'skill-1' },
      { PK: 'skill-user1', SK: 'skill2', name: 'skill-2' },
    ];
    mockSend.mockResolvedValue({ Items: mockItems });

    const result = await listSkills('user1');
    expect(result).toEqual(mockItems);

    const command = mockSend.mock.calls[0][0];
    expect(command.input.ExpressionAttributeValues[':pk']).toBe('skill-user1');
  });

  test('createSkill throws when max skills exceeded', async () => {
    const fullList = Array.from({ length: MAX_SKILLS_PER_USER }, (_, i) => ({
      PK: 'skill-user1',
      SK: `skill-${i}`,
    }));
    mockSend.mockResolvedValue({ Items: fullList });

    await expect(
      createSkill('user1', {
        name: 'new-skill',
        description: 'desc',
        fileCount: 1,
        totalSize: 100,
        s3Prefix: 'skills/user1/abc/',
      })
    ).rejects.toThrow('MAX_SKILLS_EXCEEDED');
  });

  test('createSkill uses provided skillId as SK', async () => {
    mockSend.mockResolvedValueOnce({ Items: [] });
    mockSend.mockResolvedValueOnce({});

    const result = await createSkill('user1', {
      skillId: 'my-fixed-id',
      name: 'my-skill',
      description: 'A skill',
      fileCount: 1,
      totalSize: 100,
      s3Prefix: 'skills/user1/my-fixed-id',
    });

    expect(result.SK).toBe('my-fixed-id');
    expect(result.s3Prefix).toBe('skills/user1/my-fixed-id');
  });

  test('createSkill generates SK when skillId not provided', async () => {
    mockSend.mockResolvedValueOnce({ Items: [] });
    mockSend.mockResolvedValueOnce({});

    const result = await createSkill('user1', {
      name: 'my-skill',
      description: 'A skill',
      fileCount: 2,
      totalSize: 1024,
      s3Prefix: 'skills/user1/abc/',
    });

    expect(result.PK).toBe('skill-user1');
    expect(result.SK).toBeDefined();
    expect(result.SK.length).toBeGreaterThan(0);
  });

  test('deleteSkillRecord sends correct key', async () => {
    mockSend.mockResolvedValue({});
    await deleteSkillRecord('user1', 'abc123');

    const command = mockSend.mock.calls[0][0];
    expect(command.input.Key).toEqual({ PK: 'skill-user1', SK: 'abc123' });
  });

  test('registerSkillFromFiles uses same skillId for SK and s3Prefix', async () => {
    // listSkills for storage check
    mockSend.mockResolvedValueOnce({ Items: [] });
    // PutObjectCommand for SKILL.md
    mockSend.mockResolvedValueOnce({});
    // listSkills for max check in createSkill
    mockSend.mockResolvedValueOnce({ Items: [] });
    // PutCommand for DDB
    mockSend.mockResolvedValueOnce({});

    const skillMd = '---\nname: test-skill\ndescription: A test\n---\nbody';
    const result = await registerSkillFromFiles('user1', { skillMd });

    expect(result.s3Prefix).toBe(`skills/user1/${result.SK}`);
  });

  test('registerSkillFromFiles rejects when file count exceeds limit', async () => {
    const files = Array.from({ length: MAX_SKILL_FILE_COUNT }, (_, i) => ({
      path: `file${i}.txt`,
      content: 'x',
    }));
    await expect(
      registerSkillFromFiles('user1', {
        skillMd: '---\nname: x\ndescription: x\n---\nbody',
        files,
      })
    ).rejects.toThrow('FILE_COUNT_EXCEEDED');
  });

  test('registerSkillFromFiles rejects path traversal', async () => {
    await expect(
      registerSkillFromFiles('user1', {
        skillMd: '---\nname: x\ndescription: x\n---\nbody',
        files: [{ path: '../etc/passwd', content: 'x' }],
      })
    ).rejects.toThrow('INVALID_PATH');
  });

  test('updateSkillFromFiles rejects when file count exceeds limit', async () => {
    const files = Array.from({ length: MAX_SKILL_FILE_COUNT }, (_, i) => ({
      path: `file${i}.txt`,
      content: 'x',
    }));
    await expect(
      updateSkillFromFiles('user1', 'sk1', {
        skillMd: '---\nname: x\ndescription: x\n---\nbody',
        files,
      })
    ).rejects.toThrow('FILE_COUNT_EXCEEDED');
  });

  test('updateSkillFromFiles rejects path traversal', async () => {
    await expect(
      updateSkillFromFiles('user1', 'sk1', {
        skillMd: '---\nname: x\ndescription: x\n---\nbody',
        files: [{ path: 'a/../../secret', content: 'x' }],
      })
    ).rejects.toThrow('INVALID_PATH');
  });

  test('updateSkillRecord includes ConditionExpression', async () => {
    const { updateSkillRecord } = await import('./skills');
    mockSend.mockResolvedValueOnce({ Attributes: { PK: 'skill-user1', SK: 'sk1', name: 'updated' } });

    await updateSkillRecord('user1', 'sk1', {
      name: 'updated',
      description: 'desc',
      fileCount: 1,
      totalSize: 50,
    });

    const command = mockSend.mock.calls[0][0];
    expect(command.input.ConditionExpression).toBe('attribute_exists(PK)');
  });

  test('updateSkillRecord handles undefined allowedTools without error', async () => {
    const { updateSkillRecord } = await import('./skills');
    mockSend.mockResolvedValueOnce({ Attributes: { PK: 'skill-user1', SK: 'sk1', name: 'updated', allowedTools: [] } });

    const result = await updateSkillRecord('user1', 'sk1', {
      name: 'updated',
      description: 'desc',
      allowedTools: undefined,
      fileCount: 1,
      totalSize: 50,
    });

    const command = mockSend.mock.calls[0][0];
    expect(command.input.ExpressionAttributeValues[':allowedTools']).toEqual([]);
    expect(result).toBeDefined();
  });
});

describe('skill binary and partial update support', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  const existingSkill = {
    PK: 'skill-user1',
    SK: 'sk1',
    name: 'my-skill',
    description: 'desc',
    fileCount: 2,
    totalSize: 100,
    s3Prefix: 'skills/user1/sk1',
    createdAt: 1,
    updatedAt: 1,
  };

  const routeCommands = (opts: {
    s3Objects?: { Key: string; Size: number }[];
    s3GetBodies?: Record<string, Uint8Array>;
  }) => {
    const puts: { Key: string; Body: Buffer }[] = [];
    const deletes: string[] = [];
    let updateInput: any;
    mockSend.mockImplementation((command: any) => {
      switch (command.constructor.name) {
        case 'GetCommand':
          return Promise.resolve({ Item: existingSkill });
        case 'QueryCommand':
          return Promise.resolve({ Items: [existingSkill] });
        case 'ListObjectsV2Command':
          return Promise.resolve({ Contents: opts.s3Objects ?? [], IsTruncated: false });
        case 'GetObjectCommand': {
          const bytes = opts.s3GetBodies?.[`${command.input.Bucket}/${command.input.Key}`];
          if (!bytes) return Promise.reject(new Error(`NoSuchKey: ${command.input.Key}`));
          return Promise.resolve({
            ContentLength: bytes.length,
            Body: { transformToByteArray: () => Promise.resolve(bytes) },
          });
        }
        case 'PutObjectCommand':
          puts.push({ Key: command.input.Key, Body: command.input.Body });
          return Promise.resolve({});
        case 'DeleteObjectsCommand':
          deletes.push(...command.input.Delete.Objects.map((o: any) => o.Key));
          return Promise.resolve({});
        case 'UpdateCommand':
          updateInput = command.input;
          return Promise.resolve({ Attributes: { ...existingSkill, ...updateInput.ExpressionAttributeValues } });
        default:
          return Promise.resolve({});
      }
    });
    return { puts, deletes, getUpdateInput: () => updateInput };
  };

  test('updateSkillFromFiles full replace deletes unlisted files', async () => {
    const { puts, deletes } = routeCommands({
      s3Objects: [
        { Key: 'skills/user1/sk1/SKILL.md', Size: 10 },
        { Key: 'skills/user1/sk1/old.txt', Size: 20 },
      ],
    });

    await updateSkillFromFiles('user1', 'sk1', {
      skillMd: '---\nname: my-skill\ndescription: desc\n---\nbody',
      files: [{ path: 'new.txt', content: 'hello' }],
    });

    expect(deletes).toEqual(['skills/user1/sk1/old.txt']);
    expect(puts.map((p) => p.Key).sort()).toEqual(['skills/user1/sk1/SKILL.md', 'skills/user1/sk1/new.txt']);
  });

  test('updateSkillFromFiles with keepExistingFiles keeps unlisted files and recomputes metadata from S3', async () => {
    const { puts, deletes, getUpdateInput } = routeCommands({
      s3Objects: [
        { Key: 'skills/user1/sk1/SKILL.md', Size: 10 },
        { Key: 'skills/user1/sk1/theme.tar.gz', Size: 17000000 },
        { Key: 'skills/user1/sk1/references/guide.md', Size: 30 },
      ],
    });

    const skillMd = '---\nname: my-skill\ndescription: desc\n---\nbody';
    await updateSkillFromFiles('user1', 'sk1', {
      skillMd,
      keepExistingFiles: true,
    });

    expect(deletes).toEqual([]);
    expect(puts.map((p) => p.Key)).toEqual(['skills/user1/sk1/SKILL.md']);
    const update = getUpdateInput();
    expect(update.ExpressionAttributeValues[':fileCount']).toBe(3);
    expect(update.ExpressionAttributeValues[':totalSize']).toBe(Buffer.byteLength(skillMd) + 17000000 + 30);
  });

  test('updateSkillFromFiles without skillMd keeps existing SKILL.md when keepExistingFiles', async () => {
    const existingSkillMd = '---\nname: my-skill\ndescription: from s3\n---\nbody';
    const { puts } = routeCommands({
      s3Objects: [
        { Key: 'skills/user1/sk1/SKILL.md', Size: Buffer.byteLength(existingSkillMd) },
        { Key: 'skills/user1/sk1/theme.tar.gz', Size: 100 },
      ],
      s3GetBodies: {
        'test-skill-bucket/skills/user1/sk1/SKILL.md': new TextEncoder().encode(existingSkillMd),
        'test-bucket/artifacts/theme.tar.gz': new Uint8Array([0x1f, 0x8b, 0x00, 0xff]),
      },
    });

    await updateSkillFromFiles('user1', 'sk1', {
      files: [{ path: 'theme.tar.gz', s3Uri: 's3://test-bucket/artifacts/theme.tar.gz' }],
      keepExistingFiles: true,
    });

    expect(puts.map((p) => p.Key)).toEqual(['skills/user1/sk1/theme.tar.gz']);
    expect([...puts[0].Body]).toEqual([0x1f, 0x8b, 0x00, 0xff]);
  });

  test('updateSkillFromFiles rejects missing skillMd in full replace mode', async () => {
    await expect(updateSkillFromFiles('user1', 'sk1', { files: [{ path: 'a.txt', content: 'x' }] })).rejects.toThrow(
      'SKILL_MD_REQUIRED'
    );
  });

  test('updateSkillFromFiles rejects file with both content and s3Uri', async () => {
    routeCommands({ s3Objects: [{ Key: 'skills/user1/sk1/SKILL.md', Size: 10 }] });
    await expect(
      updateSkillFromFiles('user1', 'sk1', {
        skillMd: '---\nname: x\ndescription: x\n---\nbody',
        files: [{ path: 'a.txt', content: 'x', s3Uri: 's3://b/k' }],
      })
    ).rejects.toThrow('INVALID_FILE');
  });

  test('updateSkillFromFiles rejects invalid s3 URI', async () => {
    routeCommands({ s3Objects: [{ Key: 'skills/user1/sk1/SKILL.md', Size: 10 }] });
    await expect(
      updateSkillFromFiles('user1', 'sk1', {
        skillMd: '---\nname: x\ndescription: x\n---\nbody',
        files: [{ path: 'a.txt', s3Uri: 'https://example.com/file' }],
      })
    ).rejects.toThrow('INVALID_S3_URI');
  });

  test('updateSkillFromFiles rejects SKILL.md in files array', async () => {
    await expect(
      updateSkillFromFiles('user1', 'sk1', {
        skillMd: '---\nname: x\ndescription: x\n---\nbody',
        files: [{ path: 'SKILL.md', content: 'x' }],
      })
    ).rejects.toThrow('INVALID_PATH');
  });

  test('registerSkillFromFiles preserves binary Buffer content', async () => {
    const binary = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe]);
    const puts: { Key: string; Body: Buffer }[] = [];
    mockSend.mockImplementation((command: any) => {
      switch (command.constructor.name) {
        case 'QueryCommand':
          return Promise.resolve({ Items: [] });
        case 'PutObjectCommand':
          puts.push({ Key: command.input.Key, Body: command.input.Body });
          return Promise.resolve({});
        default:
          return Promise.resolve({});
      }
    });

    await registerSkillFromFiles('user1', {
      skillMd: '---\nname: bin-skill\ndescription: d\n---\nbody',
      files: [{ path: 'theme.tar.gz', content: binary }],
    });

    const put = puts.find((p) => p.Key.endsWith('theme.tar.gz'));
    expect(put).toBeDefined();
    expect(Buffer.compare(put!.Body, binary)).toBe(0);
  });
});

describe('review follow-up guards', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  const skillMd = '---\nname: x\ndescription: x\n---\nbody';

  test('rejects duplicate paths in files', async () => {
    await expect(
      updateSkillFromFiles('user1', 'sk1', {
        skillMd,
        files: [
          { path: 'a.txt', content: 'x' },
          { path: 'a.txt', content: 'y' },
        ],
      })
    ).rejects.toThrow('DUPLICATE_PATH');
  });

  test('rejects SKILL.md in files on create too', async () => {
    await expect(
      registerSkillFromFiles('user1', { skillMd, files: [{ path: 'SKILL.md', content: 'x' }] })
    ).rejects.toThrow('INVALID_PATH');
  });

  test('rejects s3Uri outside allowed sources', async () => {
    mockSend.mockResolvedValue({ Item: { PK: 'skill-user1', SK: 'sk1', s3Prefix: 'skills/user1/sk1', totalSize: 0 } });
    await expect(
      updateSkillFromFiles('user1', 'sk1', {
        skillMd,
        files: [{ path: 'a.bin', s3Uri: 's3://someone-elses-bucket/secret' }],
      })
    ).rejects.toThrow('S3_SOURCE_NOT_ALLOWED');
    await expect(
      updateSkillFromFiles('user1', 'sk1', {
        skillMd,
        files: [{ path: 'a.bin', s3Uri: 's3://test-skill-bucket/skills/other-user/sk9/SKILL.md' }],
      })
    ).rejects.toThrow('S3_SOURCE_NOT_ALLOWED');
  });

  test('allows s3Uri from own skill prefix in skill bucket', async () => {
    mockSend.mockImplementation((command: any) => {
      switch (command.constructor.name) {
        case 'GetCommand':
          return Promise.resolve({
            Item: { PK: 'skill-user1', SK: 'sk1', s3Prefix: 'skills/user1/sk1', totalSize: 0 },
          });
        case 'QueryCommand':
          return Promise.resolve({ Items: [] });
        case 'ListObjectsV2Command':
          return Promise.resolve({ Contents: [], IsTruncated: false });
        case 'GetObjectCommand':
          return Promise.resolve({
            ContentLength: 3,
            Body: { transformToByteArray: () => Promise.resolve(new Uint8Array([1, 2, 3])) },
          });
        case 'UpdateCommand':
          return Promise.resolve({ Attributes: {} });
        default:
          return Promise.resolve({});
      }
    });
    await expect(
      updateSkillFromFiles('user1', 'sk1', {
        skillMd,
        files: [{ path: 'a.bin', s3Uri: 's3://test-skill-bucket/skills/user1/_uploads/a.bin' }],
      })
    ).resolves.toBeDefined();
  });

  test('fails fast when cumulative s3Uri sizes exceed the storage limit before buffering', async () => {
    let bodiesRead = 0;
    mockSend.mockImplementation((command: any) => {
      switch (command.constructor.name) {
        case 'GetCommand':
          return Promise.resolve({
            Item: { PK: 'skill-user1', SK: 'sk1', s3Prefix: 'skills/user1/sk1', totalSize: 0 },
          });
        case 'GetObjectCommand':
          return Promise.resolve({
            ContentLength: 60 * 1024 * 1024,
            Body: {
              transformToByteArray: () => {
                bodiesRead++;
                return Promise.resolve(new Uint8Array(1));
              },
            },
          });
        default:
          return Promise.resolve({});
      }
    });

    await expect(
      updateSkillFromFiles('user1', 'sk1', {
        skillMd,
        files: [
          { path: 'a.bin', s3Uri: 's3://test-bucket/a' },
          { path: 'b.bin', s3Uri: 's3://test-bucket/b' },
        ],
      })
    ).rejects.toThrow('STORAGE_LIMIT_EXCEEDED');
    expect(bodiesRead).toBeLessThanOrEqual(1);
  });

  test('maps missing existing SKILL.md to SKILL_MD_MISSING', async () => {
    mockSend.mockImplementation((command: any) => {
      switch (command.constructor.name) {
        case 'GetCommand':
          return Promise.resolve({
            Item: { PK: 'skill-user1', SK: 'sk1', s3Prefix: 'skills/user1/sk1', totalSize: 0 },
          });
        case 'GetObjectCommand': {
          const err = new Error('The specified key does not exist.');
          err.name = 'NoSuchKey';
          return Promise.reject(err);
        }
        default:
          return Promise.resolve({});
      }
    });

    await expect(
      updateSkillFromFiles('user1', 'sk1', {
        files: [{ path: 'a.txt', content: 'x' }],
        keepExistingFiles: true,
      })
    ).rejects.toThrow('SKILL_MD_MISSING');
  });

  test('paginates S3 listing when computing kept files', async () => {
    let listCalls = 0;
    let updateInput: any;
    mockSend.mockImplementation((command: any) => {
      switch (command.constructor.name) {
        case 'GetCommand':
          return Promise.resolve({
            Item: { PK: 'skill-user1', SK: 'sk1', s3Prefix: 'skills/user1/sk1', totalSize: 0 },
          });
        case 'QueryCommand':
          return Promise.resolve({ Items: [] });
        case 'ListObjectsV2Command': {
          listCalls++;
          if (listCalls === 1) {
            return Promise.resolve({
              Contents: [{ Key: 'skills/user1/sk1/SKILL.md', Size: 10 }],
              IsTruncated: true,
              NextContinuationToken: 'token1',
            });
          }
          return Promise.resolve({
            Contents: [{ Key: 'skills/user1/sk1/page2.bin', Size: 20 }],
            IsTruncated: false,
          });
        }
        case 'UpdateCommand':
          updateInput = command.input;
          return Promise.resolve({ Attributes: {} });
        default:
          return Promise.resolve({});
      }
    });

    const md = '---\nname: x\ndescription: x\n---\nbody';
    await updateSkillFromFiles('user1', 'sk1', { skillMd: md, keepExistingFiles: true });

    expect(listCalls).toBe(2);
    expect(updateInput.ExpressionAttributeValues[':fileCount']).toBe(2);
    expect(updateInput.ExpressionAttributeValues[':totalSize']).toBe(Buffer.byteLength(md) + 20);
  });

  test('createSkill accepts s3Uri from artifact bucket', async () => {
    const puts: { Key: string; Body: Buffer }[] = [];
    mockSend.mockImplementation((command: any) => {
      switch (command.constructor.name) {
        case 'QueryCommand':
          return Promise.resolve({ Items: [] });
        case 'GetObjectCommand':
          return Promise.resolve({
            ContentLength: 4,
            Body: { transformToByteArray: () => Promise.resolve(new Uint8Array([9, 8, 7, 6])) },
          });
        case 'PutObjectCommand':
          puts.push({ Key: command.input.Key, Body: command.input.Body });
          return Promise.resolve({});
        default:
          return Promise.resolve({});
      }
    });

    await registerSkillFromFiles('user1', {
      skillMd: '---\nname: bin-skill\ndescription: d\n---\nbody',
      files: [{ path: 'blob.bin', s3Uri: 's3://test-bucket/staging/blob.bin' }],
    });

    const put = puts.find((p) => p.Key.endsWith('blob.bin'));
    expect([...put!.Body]).toEqual([9, 8, 7, 6]);
  });
});

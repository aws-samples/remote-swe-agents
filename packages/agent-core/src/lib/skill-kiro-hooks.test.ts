import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';
import { parseSkillMd } from './skill-frontmatter';
import {
  deployKiroWorkspaceFiles,
  resolveKiroAgentName,
  KIRO_AGENT_NAME_PATTERN,
  getKiroWorkspaceDir,
  convertHooksV2ToV3,
} from './skill-catalogue';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Skill } from '../schema/skill';

describe('parseSkillMd kiro-agent field', () => {
  test('parses kiro-agent field', () => {
    const content = `---
name: my-skill
description: A skill with kiro agent
kiro-agent: aidlc
---
Body content`;

    const result = parseSkillMd(content);
    expect(result.frontmatter.kiroAgent).toBe('aidlc');
  });

  test('kiro-agent is optional', () => {
    const content = `---
name: simple-skill
description: No kiro agent
---
Body content`;

    const result = parseSkillMd(content);
    expect(result.frontmatter.kiroAgent).toBeUndefined();
  });

  test('throws on non-string kiro-agent', () => {
    const content = `---
name: bad-agent
description: Agent is not a string
kiro-agent: 123
---
Body`;
    expect(() => parseSkillMd(content)).toThrow("'kiro-agent' must be a non-empty string");
  });

  test('throws on empty kiro-agent string', () => {
    const content = `---
name: empty-agent
description: Empty agent string
kiro-agent: ""
---
Body`;
    expect(() => parseSkillMd(content)).toThrow("'kiro-agent' must be a non-empty string");
  });
});

describe('KIRO_AGENT_NAME_PATTERN (W3)', () => {
  test('allows valid names', () => {
    expect(KIRO_AGENT_NAME_PATTERN.test('aidlc')).toBe(true);
    expect(KIRO_AGENT_NAME_PATTERN.test('my-agent')).toBe(true);
    expect(KIRO_AGENT_NAME_PATTERN.test('agent_v2')).toBe(true);
    expect(KIRO_AGENT_NAME_PATTERN.test('Agent-Name_123')).toBe(true);
  });

  test('rejects invalid names', () => {
    expect(KIRO_AGENT_NAME_PATTERN.test('')).toBe(false);
    expect(KIRO_AGENT_NAME_PATTERN.test('agent name')).toBe(false);
    expect(KIRO_AGENT_NAME_PATTERN.test('agent/name')).toBe(false);
    expect(KIRO_AGENT_NAME_PATTERN.test('../escape')).toBe(false);
    expect(KIRO_AGENT_NAME_PATTERN.test('agent.name')).toBe(false);
    expect(KIRO_AGENT_NAME_PATTERN.test('agent\x00name')).toBe(false);
  });
});

describe('deployKiroWorkspaceFiles', () => {
  let tmpDir: string;
  let skillsDir: string;
  let repoCwd: string;
  let workerId: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-kiro-test-'));
    skillsDir = path.join(tmpDir, 'skills');
    repoCwd = path.join(tmpDir, 'repo');
    workerId = `test-worker-${Date.now()}`;
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.mkdirSync(repoCwd, { recursive: true });
    // Initialize a git repo so .git/info/exclude works
    fs.mkdirSync(path.join(repoCwd, '.git', 'info'), { recursive: true });
    process.env.SKILLS_LOCAL_DIR = skillsDir;
    process.env.KIRO_WORKSPACE_BASE = path.join(tmpDir, 'kiro-workspace');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.SKILLS_LOCAL_DIR;
    delete process.env.KIRO_WORKSPACE_BASE;
  });

  const makeSkill = (id: string, updatedAt = Date.now()): Skill => ({
    PK: 'user#test',
    SK: id,
    name: 'test-skill',
    description: 'A test skill',
    fileCount: 1,
    totalSize: 100,
    s3Prefix: `skills/${id}`,
    createdAt: Date.now(),
    updatedAt,
  });

  test('deploys .kiro directory OUTSIDE repo to kiro workspace (C1)', () => {
    const skill = makeSkill('skill-1');
    const skillDir = path.join(skillsDir, skill.SK);
    const kiroDir = path.join(skillDir, '.kiro', 'hooks');
    fs.mkdirSync(kiroDir, { recursive: true });
    fs.writeFileSync(path.join(kiroDir, 'test-hook.sh'), '#!/bin/bash\nexit 0\n');
    fs.mkdirSync(path.join(skillDir, '.kiro', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(skillDir, '.kiro', 'agents', 'test.json'), JSON.stringify({ name: 'test', hooks: {} }));
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: test-skill\ndescription: Test\nkiro-agent: test\n---\nBody'
    );

    const result = deployKiroWorkspaceFiles([skill], repoCwd, workerId);

    expect(result).toBe('test');

    const kiroWorkspace = getKiroWorkspaceDir(workerId);
    expect(fs.existsSync(path.join(kiroWorkspace, '.kiro', 'hooks', 'test-hook.sh'))).toBe(true);
    expect(fs.existsSync(path.join(kiroWorkspace, '.kiro', 'agents', 'test.json'))).toBe(true);

    const repoKiroLink = path.join(repoCwd, '.kiro');
    expect(fs.lstatSync(repoKiroLink).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(repoKiroLink)).toBe(path.join(kiroWorkspace, '.kiro'));
    expect(fs.existsSync(path.join(repoCwd, '.kiro', 'hooks', 'test-hook.sh'))).toBe(true);
  });

  test('CR1: symlink is excluded from git via .git/info/exclude', () => {
    const skill = makeSkill('skill-1');
    const skillDir = path.join(skillsDir, skill.SK);
    fs.mkdirSync(path.join(skillDir, '.kiro', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(skillDir, '.kiro', 'agents', 'test.json'), '{}');
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: test-skill\ndescription: Test\nkiro-agent: test\n---\nBody'
    );

    deployKiroWorkspaceFiles([skill], repoCwd, workerId);

    const excludeFile = path.join(repoCwd, '.git', 'info', 'exclude');
    expect(fs.existsSync(excludeFile)).toBe(true);
    const content = fs.readFileSync(excludeFile, 'utf-8');
    expect(content).toContain('.kiro');
  });

  test('CR1: git exclude entry is idempotent on repeated deploys', () => {
    const skill = makeSkill('skill-1');
    const skillDir = path.join(skillsDir, skill.SK);
    fs.mkdirSync(path.join(skillDir, '.kiro', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(skillDir, '.kiro', 'agents', 'test.json'), '{}');
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: test-skill\ndescription: Test\nkiro-agent: test\n---\nBody'
    );

    deployKiroWorkspaceFiles([skill], repoCwd, workerId);
    deployKiroWorkspaceFiles([skill], repoCwd, workerId);

    const excludeFile = path.join(repoCwd, '.git', 'info', 'exclude');
    const content = fs.readFileSync(excludeFile, 'utf-8');
    const matches = content.split('\n').filter((l) => l === '.kiro');
    expect(matches.length).toBe(1);
  });

  test('CR2: does NOT destroy existing real .kiro/ directory', () => {
    const skill = makeSkill('skill-1');
    const skillDir = path.join(skillsDir, skill.SK);
    fs.mkdirSync(path.join(skillDir, '.kiro', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(skillDir, '.kiro', 'agents', 'test.json'), '{}');
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: test-skill\ndescription: Test\nkiro-agent: test\n---\nBody'
    );

    // Create a real .kiro/ directory in the repo (user-owned)
    const realKiroDir = path.join(repoCwd, '.kiro');
    fs.mkdirSync(path.join(realKiroDir, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(realKiroDir, 'agents', 'user-config.json'), '{"user": true}');

    const warnSpy = vi.spyOn(console, 'warn');
    const result = deployKiroWorkspaceFiles([skill], repoCwd, workerId);

    // User's .kiro/ must still be intact
    expect(fs.existsSync(path.join(realKiroDir, 'agents', 'user-config.json'))).toBe(true);
    expect(fs.lstatSync(realKiroDir).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(realKiroDir).isDirectory()).toBe(true);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('real .kiro/ directory'));
    warnSpy.mockRestore();

    // CR2 skip path returns undefined — hooks are not discoverable via symlink
    // so --agent must NOT be passed to avoid referencing a potentially missing agent JSON
    expect(result).toBeUndefined();
  });

  test('CR2: replaces existing symlink on redeploy', () => {
    const skill = makeSkill('skill-1');
    const skillDir = path.join(skillsDir, skill.SK);
    fs.mkdirSync(path.join(skillDir, '.kiro', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(skillDir, '.kiro', 'agents', 'test.json'), '{}');
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: test-skill\ndescription: Test\nkiro-agent: test\n---\nBody'
    );

    // First deploy creates symlink
    deployKiroWorkspaceFiles([skill], repoCwd, workerId);
    expect(fs.lstatSync(path.join(repoCwd, '.kiro')).isSymbolicLink()).toBe(true);

    // Second deploy replaces it cleanly
    deployKiroWorkspaceFiles([skill], repoCwd, workerId);
    expect(fs.lstatSync(path.join(repoCwd, '.kiro')).isSymbolicLink()).toBe(true);
  });

  test('skips skills without .kiro directory', () => {
    const skill = makeSkill('skill-no-kiro');
    const skillDir = path.join(skillsDir, skill.SK);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: x\ndescription: y\n---\nBody');

    const result = deployKiroWorkspaceFiles([skill], repoCwd, workerId);
    expect(result).toBeUndefined();
    expect(fs.existsSync(path.join(repoCwd, '.kiro'))).toBe(false);
  });

  test('W1: most recently updated skill wins on conflicting files', () => {
    const oldSkill = makeSkill('skill-old', 1000);
    const newSkill = makeSkill('skill-new', 2000);

    for (const [skill, content] of [
      [oldSkill, 'old-content'],
      [newSkill, 'new-content'],
    ] as const) {
      const skillDir = path.join(skillsDir, skill.SK);
      fs.mkdirSync(path.join(skillDir, '.kiro', 'hooks'), { recursive: true });
      fs.writeFileSync(path.join(skillDir, '.kiro', 'hooks', 'shared-hook.sh'), content);
      fs.mkdirSync(path.join(skillDir, '.kiro', 'agents'), { recursive: true });
      fs.writeFileSync(path.join(skillDir, '.kiro', 'agents', 'test.json'), '{}');
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        '---\nname: test-skill\ndescription: Test\nkiro-agent: test\n---\nBody'
      );
    }

    deployKiroWorkspaceFiles([oldSkill, newSkill], repoCwd, workerId);

    const kiroWorkspace = getKiroWorkspaceDir(workerId);
    const content = fs.readFileSync(path.join(kiroWorkspace, '.kiro', 'hooks', 'shared-hook.sh'), 'utf-8');
    expect(content).toBe('new-content');
  });

  test('W2: cleans stale hooks on redeployment', () => {
    const skill = makeSkill('skill-1');
    const skillDir = path.join(skillsDir, skill.SK);
    fs.mkdirSync(path.join(skillDir, '.kiro', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(skillDir, '.kiro', 'hooks', 'hook-v1.sh'), 'v1');
    fs.mkdirSync(path.join(skillDir, '.kiro', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(skillDir, '.kiro', 'agents', 'test.json'), '{}');
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: test-skill\ndescription: Test\nkiro-agent: test\n---\nBody'
    );

    deployKiroWorkspaceFiles([skill], repoCwd, workerId);
    const kiroWorkspace = getKiroWorkspaceDir(workerId);
    expect(fs.existsSync(path.join(kiroWorkspace, '.kiro', 'hooks', 'hook-v1.sh'))).toBe(true);

    fs.unlinkSync(path.join(skillDir, '.kiro', 'hooks', 'hook-v1.sh'));
    fs.writeFileSync(path.join(skillDir, '.kiro', 'hooks', 'hook-v2.sh'), 'v2');

    deployKiroWorkspaceFiles([skill], repoCwd, workerId);
    expect(fs.existsSync(path.join(kiroWorkspace, '.kiro', 'hooks', 'hook-v1.sh'))).toBe(false);
    expect(fs.existsSync(path.join(kiroWorkspace, '.kiro', 'hooks', 'hook-v2.sh'))).toBe(true);
  });

  test('W3: rejects invalid kiro-agent name and skips deployment', () => {
    const skill = makeSkill('skill-bad-name');
    const skillDir = path.join(skillsDir, skill.SK);
    fs.mkdirSync(path.join(skillDir, '.kiro', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(skillDir, '.kiro', 'hooks', 'hook.sh'), 'echo hello');
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: bad-name-skill\ndescription: Bad agent name\nkiro-agent: "../escape"\n---\nBody'
    );

    const result = deployKiroWorkspaceFiles([skill], repoCwd, workerId);
    expect(result).toBeUndefined();
    expect(fs.existsSync(path.join(repoCwd, '.kiro'))).toBe(false);
  });

  test('C2: throws when agent JSON is missing after deployment', () => {
    const skill = makeSkill('skill-missing-json');
    const skillDir = path.join(skillsDir, skill.SK);
    fs.mkdirSync(path.join(skillDir, '.kiro', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(skillDir, '.kiro', 'hooks', 'hook.sh'), 'echo hello');
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: missing-json\ndescription: Missing agent JSON\nkiro-agent: myagent\n---\nBody'
    );

    expect(() => deployKiroWorkspaceFiles([skill], repoCwd, workerId)).toThrow(/Agent JSON not found.*myagent\.json/);
  });

  test('W-C: symlinks in source .kiro/ content are skipped (not followed)', () => {
    const skill = makeSkill('skill-symlink');
    const skillDir = path.join(skillsDir, skill.SK);
    const kiroDir = path.join(skillDir, '.kiro');
    fs.mkdirSync(path.join(kiroDir, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(kiroDir, 'agents', 'safe.json'), '{"name":"safe"}');
    fs.writeFileSync(path.join(kiroDir, 'legit-file.txt'), 'legitimate content');
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: symlink-skill\ndescription: Test\nkiro-agent: safe\n---\nBody'
    );

    // Create a symlink in .kiro/ pointing to an external file
    const externalFile = path.join(tmpDir, 'secret.txt');
    fs.writeFileSync(externalFile, 'SECRET DATA');
    fs.symlinkSync(externalFile, path.join(kiroDir, 'evil-link'));

    const warnSpy = vi.spyOn(console, 'warn');
    deployKiroWorkspaceFiles([skill], repoCwd, workerId);

    const kiroWorkspace = getKiroWorkspaceDir(workerId);
    // Legitimate file deployed
    expect(fs.existsSync(path.join(kiroWorkspace, '.kiro', 'legit-file.txt'))).toBe(true);
    // Symlink was NOT followed/copied
    expect(fs.existsSync(path.join(kiroWorkspace, '.kiro', 'evil-link'))).toBe(false);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Skipping symlink'));
    warnSpy.mockRestore();
  });

  test('S2: warns on conflicting kiro-agent declarations', () => {
    const warnSpy = vi.spyOn(console, 'warn');

    const skill1 = makeSkill('skill-agent-a', 2000);
    const skill2 = makeSkill('skill-agent-b', 1000);

    for (const [skill, agentName] of [
      [skill1, 'agent-a'],
      [skill2, 'agent-b'],
    ] as const) {
      const skillDir = path.join(skillsDir, skill.SK);
      fs.mkdirSync(path.join(skillDir, '.kiro', 'agents'), { recursive: true });
      fs.writeFileSync(path.join(skillDir, '.kiro', 'agents', `${agentName}.json`), '{}');
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        `---\nname: ${agentName}-skill\ndescription: Test\nkiro-agent: ${agentName}\n---\nBody`
      );
    }

    deployKiroWorkspaceFiles([skill1, skill2], repoCwd, workerId);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('CONFLICTING kiro-agent declarations'));
    warnSpy.mockRestore();
  });

  test('CR3/CR4: returns undefined when deployment is skipped (no .kiro in skills)', () => {
    const skill = makeSkill('skill-no-kiro');
    const skillDir = path.join(skillsDir, skill.SK);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: x\ndescription: y\n---\nBody');

    const result = deployKiroWorkspaceFiles([skill], repoCwd, workerId);
    expect(result).toBeUndefined();
  });

  test('W-D: KIRO_WORKSPACE_BASE is injectable via env var', () => {
    const customBase = path.join(tmpDir, 'custom-kiro-base');
    process.env.KIRO_WORKSPACE_BASE = customBase;

    const skill = makeSkill('skill-custom-base');
    const skillDir = path.join(skillsDir, skill.SK);
    fs.mkdirSync(path.join(skillDir, '.kiro', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(skillDir, '.kiro', 'agents', 'test.json'), '{}');
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: test\ndescription: Test\nkiro-agent: test\n---\nBody'
    );

    deployKiroWorkspaceFiles([skill], repoCwd, workerId);

    const expectedDir = path.join(customBase, workerId, '.kiro', 'agents', 'test.json');
    expect(fs.existsSync(expectedDir)).toBe(true);
  });
});

describe('resolveKiroAgentName', () => {
  let tmpDir: string;
  let skillsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-resolve-test-'));
    skillsDir = path.join(tmpDir, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    process.env.SKILLS_LOCAL_DIR = skillsDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.SKILLS_LOCAL_DIR;
  });

  const makeSkill = (id: string, updatedAt: number): Skill => ({
    PK: 'user#test',
    SK: id,
    name: 'test-skill',
    description: 'A test skill',
    fileCount: 1,
    totalSize: 100,
    s3Prefix: `skills/${id}`,
    createdAt: Date.now(),
    updatedAt,
  });

  test('returns agent name from skill with kiro-agent frontmatter', () => {
    const skill = makeSkill('skill-with-agent', 1000);
    const skillDir = path.join(skillsDir, skill.SK);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: aidlc-workflows\ndescription: AI-DLC\nkiro-agent: aidlc\n---\nBody'
    );

    const result = resolveKiroAgentName([skill]);
    expect(result).toBe('aidlc');
  });

  test('returns undefined when no skill has kiro-agent', () => {
    const skill = makeSkill('skill-no-agent', 1000);
    const skillDir = path.join(skillsDir, skill.SK);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: simple-skill\ndescription: Simple\n---\nBody');

    const result = resolveKiroAgentName([skill]);
    expect(result).toBeUndefined();
  });

  test('returns agent from most recently updated skill', () => {
    const skill1 = makeSkill('skill-old', 500);
    const skill2 = makeSkill('skill-new', 2000);

    const skillDir1 = path.join(skillsDir, skill1.SK);
    fs.mkdirSync(skillDir1, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir1, 'SKILL.md'),
      '---\nname: old-skill\ndescription: Old\nkiro-agent: old-agent\n---\nBody'
    );

    const skillDir2 = path.join(skillsDir, skill2.SK);
    fs.mkdirSync(skillDir2, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir2, 'SKILL.md'),
      '---\nname: new-skill\ndescription: New\nkiro-agent: new-agent\n---\nBody'
    );

    const result = resolveKiroAgentName([skill1, skill2]);
    expect(result).toBe('new-agent');
  });

  test('handles missing SKILL.md gracefully', () => {
    const skill = makeSkill('skill-missing-md', 1000);

    const result = resolveKiroAgentName([skill]);
    expect(result).toBeUndefined();
  });

  test('W3: skips skills with invalid kiro-agent names', () => {
    const skill1 = makeSkill('skill-bad', 2000);
    const skill2 = makeSkill('skill-good', 1000);

    const skillDir1 = path.join(skillsDir, skill1.SK);
    fs.mkdirSync(skillDir1, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir1, 'SKILL.md'),
      '---\nname: bad-skill\ndescription: Bad\nkiro-agent: "../traversal"\n---\nBody'
    );

    const skillDir2 = path.join(skillsDir, skill2.SK);
    fs.mkdirSync(skillDir2, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir2, 'SKILL.md'),
      '---\nname: good-skill\ndescription: Good\nkiro-agent: valid-agent\n---\nBody'
    );

    const result = resolveKiroAgentName([skill1, skill2]);
    expect(result).toBe('valid-agent');
  });
});

describe('convertHooksV2ToV3', () => {
  test('converts v2 single-trigger single-hook format', () => {
    const v2Hooks = {
      preToolUse: [{ command: '.kiro/hooks/block.sh' }],
    };
    const result = convertHooksV2ToV3(v2Hooks);
    expect(result).toEqual([
      { name: 'preToolUse-0', trigger: 'preToolUse', action: { type: 'command', command: '.kiro/hooks/block.sh' } },
    ]);
  });

  test('converts v2 multiple triggers and hooks (matcher dropped with warn)', () => {
    const warnSpy = vi.spyOn(console, 'warn');
    const v2Hooks = {
      preToolUse: [{ command: 'validate.sh', matcher: 'shell' }, { command: 'audit.sh' }],
      postToolUse: [{ command: 'format.sh', matcher: 'fs_write' }],
    };
    const result = convertHooksV2ToV3(v2Hooks);
    expect(result).toHaveLength(3);
    expect(result![0]).toEqual({
      name: 'preToolUse-0',
      trigger: 'preToolUse',
      action: { type: 'command', command: 'validate.sh' },
    });
    expect(result![1]).toEqual({
      name: 'preToolUse-1',
      trigger: 'preToolUse',
      action: { type: 'command', command: 'audit.sh' },
    });
    expect(result![2]).toEqual({
      name: 'postToolUse-0',
      trigger: 'postToolUse',
      action: { type: 'command', command: 'format.sh' },
    });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('matcher'));
    warnSpy.mockRestore();
  });

  test('passes through v3 array format unchanged', () => {
    const v3Hooks = [{ name: 'block', trigger: 'preToolUse', action: { type: 'command', command: 'hook.sh' } }];
    const result = convertHooksV2ToV3(v3Hooks);
    expect(result).toBe(v3Hooks);
  });

  test('returns undefined for null/undefined hooks', () => {
    expect(convertHooksV2ToV3(undefined)).toBeUndefined();
    expect(convertHooksV2ToV3(null)).toBeUndefined();
  });

  test('returns undefined for empty v2 hooks object', () => {
    expect(convertHooksV2ToV3({})).toBeUndefined();
  });

  test('auto-generates unique names per trigger and index', () => {
    const v2Hooks = {
      agentSpawn: [{ command: 'spawn.sh' }],
      preToolUse: [{ command: 'a.sh' }, { command: 'b.sh' }],
    };
    const result = convertHooksV2ToV3(v2Hooks);
    const names = result!.map((h) => h.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('agentSpawn-0');
    expect(names).toContain('preToolUse-0');
    expect(names).toContain('preToolUse-1');
  });

  test('converts entries with matcher but warns about dropped matcher', () => {
    const warnSpy = vi.spyOn(console, 'warn');
    const v2Hooks = {
      preToolUse: [{ command: 'validate.sh', matcher: 'shell' }, { command: 'audit.sh' }],
    };
    const result = convertHooksV2ToV3(v2Hooks);
    expect(result).toHaveLength(2);
    expect(result![0].action.command).toBe('validate.sh');
    expect(result![1].action.command).toBe('audit.sh');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('matcher'));
    warnSpy.mockRestore();
  });

  test('skips entries without command field and warns', () => {
    const warnSpy = vi.spyOn(console, 'warn');
    const v2Hooks = {
      preToolUse: [{ command: 'valid.sh' }, { matcher: 'shell' }],
    };
    const result = convertHooksV2ToV3(v2Hooks);
    expect(result).toHaveLength(1);
    expect(result![0].action.command).toBe('valid.sh');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('skipped'));
    warnSpy.mockRestore();
  });

  test('warns when all entries are skipped (0 results)', () => {
    const warnSpy = vi.spyOn(console, 'warn');
    const v2Hooks = {
      preToolUse: [{ matcher: 'shell' }, { timeout: 5000 }],
    };
    const result = convertHooksV2ToV3(v2Hooks);
    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('produced 0 entries'));
    warnSpy.mockRestore();
  });
});

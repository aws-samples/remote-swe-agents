import { ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { s3, SkillBucketName } from './aws';
import { Skill, CATALOGUE_MAX_BYTES, CATALOGUE_MAX_SKILLS, CATALOGUE_TRUNCATED_DESC_LENGTH } from '../schema/skill';
import * as fs from 'fs';
import * as path from 'path';
import { parseSkillMd } from './skill-frontmatter';

/**
 * Local directory where skill files are downloaded from S3.
 * Configurable via SKILLS_LOCAL_DIR env var for test isolation (C3).
 */
export const getSkillsLocalDir = (): string => process.env.SKILLS_LOCAL_DIR || '/tmp/skills';

/**
 * Base directory for kiro-native workspace files deployed outside the repo (C1).
 * Configurable via KIRO_WORKSPACE_BASE env var for test isolation (W-D).
 * Each worker gets its own subdirectory: `{base}/{workerId}/.kiro/`
 */
export const getKiroWorkspaceBase = (): string => process.env.KIRO_WORKSPACE_BASE || '/tmp/kiro-workspace';

/**
 * Regex pattern for valid kiro-agent names (W3).
 * Only alphanumeric, hyphens, and underscores allowed.
 */
export const KIRO_AGENT_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Get the kiro workspace directory for a given worker.
 * Returns `{base}/{workerId}`. workerId is validated to prevent path traversal
 * in the rm -rf path (W-D).
 */
export const getKiroWorkspaceDir = (workerId: string): string => {
  if (!workerId || !KIRO_AGENT_NAME_PATTERN.test(workerId.replace(/\./g, ''))) {
    throw new Error(`[skill-catalogue] Invalid workerId for kiro workspace: "${workerId}"`);
  }
  return path.join(getKiroWorkspaceBase(), workerId);
};

export const buildSkillCatalogue = (skills: Skill[]): string => {
  if (skills.length === 0) return '';

  const sorted = [...skills].sort((a, b) => b.updatedAt - a.updatedAt);
  const limited = sorted.slice(0, CATALOGUE_MAX_SKILLS);

  let catalogue = `## Available Skills

The following skills are available. When a user's request matches a skill, read the full skill content using the Read tool before proceeding.

| Skill | Description | Path |
|-------|-------------|------|
`;

  let currentSize = Buffer.byteLength(catalogue, 'utf8');

  for (const skill of limited) {
    let desc = skill.description;
    if (desc.length > CATALOGUE_TRUNCATED_DESC_LENGTH) {
      desc = desc.slice(0, CATALOGUE_TRUNCATED_DESC_LENGTH - 3) + '...';
    }
    const row = `| ${skill.name} | ${desc} | ${getSkillsLocalDir()}/${skill.SK}/SKILL.md |\n`;
    const rowSize = Buffer.byteLength(row, 'utf8');

    if (currentSize + rowSize > CATALOGUE_MAX_BYTES) break;
    catalogue += row;
    currentSize += rowSize;
  }

  if (skills.length > CATALOGUE_MAX_SKILLS) {
    catalogue += '\nAdditional skills available. Ask the user which skill to use.';
  }

  catalogue += `\nTo activate a skill, read its SKILL.md file. If the skill has \`allowed-tools\`, only those tools may be used for the remainder of that turn.`;

  return catalogue;
};

export const downloadSkillFiles = async (skills: Skill[]): Promise<void> => {
  const skillsLocalDir = getSkillsLocalDir();
  // Clean up old skill files
  if (fs.existsSync(skillsLocalDir)) {
    fs.rmSync(skillsLocalDir, { recursive: true, force: true });
  }
  fs.mkdirSync(skillsLocalDir, { recursive: true });

  for (const skill of skills) {
    const skillDir = path.join(skillsLocalDir, skill.SK);
    fs.mkdirSync(skillDir, { recursive: true });

    try {
      const prefix = skill.s3Prefix.endsWith('/') ? skill.s3Prefix : `${skill.s3Prefix}/`;
      const listRes = await s3.send(
        new ListObjectsV2Command({
          Bucket: SkillBucketName,
          Prefix: prefix,
        })
      );

      if (!listRes.Contents) continue;

      for (const obj of listRes.Contents) {
        if (!obj.Key) continue;
        const relativePath = obj.Key.slice(prefix.length);
        if (!relativePath) continue;

        const localPath = path.join(skillDir, relativePath);
        const localDir = path.dirname(localPath);

        // Security: ensure resolved path is within skillDir
        const resolved = path.resolve(localPath);
        if (!resolved.startsWith(path.resolve(skillDir))) {
          console.warn(`[skill-catalogue] Skipping path traversal attempt: ${relativePath}`);
          continue;
        }

        fs.mkdirSync(localDir, { recursive: true });

        const { Body } = await s3.send(new GetObjectCommand({ Bucket: SkillBucketName, Key: obj.Key }));
        if (Body) {
          const bytes = await Body.transformToByteArray();
          fs.writeFileSync(localPath, bytes);
        }
      }
    } catch (error) {
      console.warn(`[skill-catalogue] Failed to download files for skill ${skill.SK}:`, error);
    }
  }
};

/**
 * Deploy kiro-native workspace files (`.kiro/` directory) from downloaded
 * skills into a workspace directory OUTSIDE the repository (C1). The deploy
 * target is `{KIRO_WORKSPACE_BASE}/{workerId}/.kiro/`. A symlink is created
 * from `{repoCwd}/.kiro` → the deploy target so kiro-cli (whose cwd is the
 * repo) discovers the hooks and agent config without polluting the repo
 * working tree.
 *
 * ## CR1: The symlink is excluded from git via `.git/info/exclude` to prevent
 * accidental commit via `git add -A`.
 *
 * ## CR2: If the repo already contains a real (non-symlink) `.kiro/`
 * directory, deployment is skipped with a warning to avoid destroying
 * user-owned content.
 *
 * ## CR3/CR4: Returns the validated kiro-agent name on success so the caller
 * can store it for later use by kiro-agent-loop (preventing --agent from
 * being passed when deployment failed). The verification target is unified
 * with resolveKiroAgentName's resolution logic.
 *
 * ## W1: Skills are sorted by `updatedAt` ascending before deployment so
 * the most-recently-updated skill deploys last and wins via last-write-wins.
 *
 * ## W2: Stale `.kiro/` content is cleaned before each deploy cycle.
 *
 * ## W6: Hook scripts are expected to be executed via an interpreter
 * (e.g. `bun run <hook.ts>`, `bash <hook.sh>`). kiro-cli determines the
 * interpreter from the file extension or shebang. No raw binary execution.
 *
 * @returns The validated kiro-agent name on successful deployment, or
 * undefined if no skill declares a kiro-agent or deployment was skipped.
 * @throws Error if deployment proceeds but the resolved agent JSON is missing.
 */
export const deployKiroWorkspaceFiles = (skills: Skill[], repoCwd: string, workerId: string): string | undefined => {
  const kiroWorkspaceDir = getKiroWorkspaceDir(workerId);
  const kiroDest = path.join(kiroWorkspaceDir, '.kiro');

  // W2: Clean up existing .kiro/ content before deploying fresh files.
  if (fs.existsSync(kiroDest)) {
    fs.rmSync(kiroDest, { recursive: true, force: true });
  }
  fs.mkdirSync(kiroDest, { recursive: true });

  // W1: Sort skills by updatedAt ASCENDING so the most-recently-updated
  // skill deploys LAST and its files win via last-write-wins overwrite.
  const sorted = [...skills].sort((a, b) => a.updatedAt - b.updatedAt);

  // S2: Detect conflicting kiro-agent declarations across skills.
  const agentDeclarations: Array<{ skillId: string; agentName: string }> = [];

  let deployedAny = false;
  for (const skill of sorted) {
    const skillDir = path.join(getSkillsLocalDir(), skill.SK);
    const kiroSrc = path.join(skillDir, '.kiro');

    if (!fs.existsSync(kiroSrc) || !fs.statSync(kiroSrc).isDirectory()) {
      continue;
    }

    const skillMdPath = path.join(skillDir, 'SKILL.md');
    if (fs.existsSync(skillMdPath)) {
      try {
        const content = fs.readFileSync(skillMdPath, 'utf-8');
        const { frontmatter } = parseSkillMd(content);
        if (frontmatter.kiroAgent) {
          if (!KIRO_AGENT_NAME_PATTERN.test(frontmatter.kiroAgent)) {
            console.error(
              `[skill-catalogue] INVALID kiro-agent name "${frontmatter.kiroAgent}" in skill ${skill.SK}. ` +
                `Must match ${KIRO_AGENT_NAME_PATTERN}. Skipping .kiro/ deployment for this skill.`
            );
            continue;
          }
          agentDeclarations.push({ skillId: skill.SK, agentName: frontmatter.kiroAgent });
        }
      } catch {
        // Frontmatter parse failure is non-fatal for deployment
      }
    }

    copyDirRecursive(kiroSrc, kiroDest);
    deployedAny = true;
    console.log(`[skill-catalogue] Deployed .kiro/ from skill ${skill.SK} to ${kiroDest}`);
  }

  // S2: Warn if multiple skills declare different kiro-agent names.
  // Use resolveKiroAgentName to determine the actual winner (consistent
  // with what kiro-agent-loop would resolve).
  if (agentDeclarations.length > 1) {
    const uniqueNames = [...new Set(agentDeclarations.map((d) => d.agentName))];
    if (uniqueNames.length > 1) {
      const actualWinner = resolveKiroAgentName(skills);
      console.warn(
        `[skill-catalogue] CONFLICTING kiro-agent declarations detected: ` +
          agentDeclarations.map((d) => `${d.skillId}→"${d.agentName}"`).join(', ') +
          `. The effective winner (per resolveKiroAgentName) is "${actualWinner ?? '(none)'}".`
      );
    }
  }

  if (deployedAny) {
    // CR2: Check if repoCwd already has a real (non-symlink) .kiro directory.
    // If so, we must NOT destroy it — skip symlink creation and warn.
    const repoKiroLink = path.join(repoCwd, '.kiro');
    try {
      const stat = fs.lstatSync(repoKiroLink);
      if (stat.isSymbolicLink()) {
        // Our own previous symlink — safe to replace
        fs.unlinkSync(repoKiroLink);
      } else if (stat.isDirectory() || stat.isFile()) {
        // CR2: Real user-owned .kiro/ exists. Do NOT destroy it.
        // Return undefined so --agent is NOT passed — our deployed hooks are
        // not discoverable (symlink not created) and the user's .kiro/ may
        // not contain the expected agent JSON.
        console.warn(
          `[skill-catalogue] repoCwd already contains a real .kiro/ directory (not a symlink). ` +
            `Skipping symlink creation to avoid destroying user-owned content. ` +
            `Hooks will not be discoverable by kiro-cli via symlink; --agent will not be passed.`
        );
        return undefined;
      }
    } catch {
      // lstatSync throws if path doesn't exist — that's fine, proceed
    }

    fs.symlinkSync(kiroDest, repoKiroLink, 'dir');
    console.log(`[skill-catalogue] Created symlink ${repoKiroLink} → ${kiroDest}`);

    // CR1: Add .kiro to .git/info/exclude so `git add -A` doesn't commit the symlink.
    addToGitExclude(repoCwd, '.kiro');
  }

  // Convert v2-format hooks to v3 array format in deployed agent JSONs.
  // This ensures skills authored in v2 format (object with trigger keys)
  // work correctly when the worker uses the v3 engine (KAS).
  transformDeployedAgentHooksForV3(kiroDest);

  // CR3/CR4: Use resolveKiroAgentName for the authoritative agent name resolution
  // (same logic kiro-agent-loop would use). Verify the agent JSON exists for
  // the resolved name.
  const resolvedAgent = resolveKiroAgentName(skills);
  if (resolvedAgent) {
    const agentJsonPath = path.join(kiroDest, 'agents', `${resolvedAgent}.json`);
    if (!fs.existsSync(agentJsonPath)) {
      throw new Error(
        `[skill-catalogue] Agent JSON not found at ${agentJsonPath} after deployment. ` +
          `The skill declares kiro-agent="${resolvedAgent}" but did not provide ` +
          `.kiro/agents/${resolvedAgent}.json. Hook activation will fail.`
      );
    }
    console.log(`[skill-catalogue] Verified agent JSON exists: ${agentJsonPath}`);
  }

  return resolvedAgent;
};

/**
 * CR1: Idempotently add an entry to .git/info/exclude so git ignores
 * the symlink. This prevents `git add -A` from committing it as a
 * mode 120000 blob containing an absolute path.
 */
const addToGitExclude = (repoCwd: string, pattern: string): void => {
  const gitDir = path.join(repoCwd, '.git');
  if (!fs.existsSync(gitDir)) {
    return;
  }
  const excludeFile = path.join(gitDir, 'info', 'exclude');
  try {
    const dir = path.dirname(excludeFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const existing = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf-8') : '';
    const lines = existing.split('\n');
    if (!lines.includes(pattern)) {
      const content =
        existing.endsWith('\n') || existing === '' ? `${existing}${pattern}\n` : `${existing}\n${pattern}\n`;
      fs.writeFileSync(excludeFile, content);
      console.log(`[skill-catalogue] Added "${pattern}" to ${excludeFile}`);
    }
  } catch (error) {
    console.warn(`[skill-catalogue] Failed to update .git/info/exclude:`, error);
  }
};

const copyDirRecursive = (src: string, dest: string): void => {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    const resolved = path.resolve(destPath);
    if (!resolved.startsWith(path.resolve(dest))) {
      console.warn(`[skill-catalogue] Skipping path traversal in .kiro/ deploy: ${entry.name}`);
      continue;
    }
    // W-C: Use lstatSync to detect symlinks in source. Symlinks in skill
    // .kiro/ content could point outside the skill directory (traversal).
    // Skip them rather than following via copyFileSync.
    const srcStat = fs.lstatSync(srcPath);
    if (srcStat.isSymbolicLink()) {
      console.warn(`[skill-catalogue] Skipping symlink in .kiro/ source: ${srcPath}`);
      continue;
    }
    if (srcStat.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
};

/**
 * Determine the kiro-cli agent name to use from the user's registered skills.
 *
 * Scans each skill's SKILL.md for a `kiro-agent` frontmatter field. Returns
 * the first match found (skill priority = most recently updated). Returns
 * `undefined` when no skill declares a kiro agent — the worker then starts
 * kiro-cli without the `--agent` flag (default built-in agent).
 *
 * W3: Agent names are validated against `^[a-zA-Z0-9_-]+$`. Invalid names
 * are logged and skipped.
 */
export const resolveKiroAgentName = (skills: Skill[]): string | undefined => {
  const sorted = [...skills].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const skill of sorted) {
    const skillMdPath = path.join(getSkillsLocalDir(), skill.SK, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) continue;
    try {
      const content = fs.readFileSync(skillMdPath, 'utf-8');
      const { frontmatter } = parseSkillMd(content);
      if (frontmatter.kiroAgent) {
        if (!KIRO_AGENT_NAME_PATTERN.test(frontmatter.kiroAgent)) {
          console.warn(
            `[skill-catalogue] Skipping invalid kiro-agent name "${frontmatter.kiroAgent}" in skill ${skill.SK}. ` +
              `Must match ${KIRO_AGENT_NAME_PATTERN}.`
          );
          continue;
        }
        return frontmatter.kiroAgent;
      }
    } catch {
      // Frontmatter parse failure is non-fatal for agent resolution
    }
  }
  return undefined;
};

/**
 * v3 hook entry schema: KAS expects hooks as an array of objects with
 * name, trigger, and action fields.
 */
export interface V3HookEntry {
  name: string;
  trigger: string;
  action: { type: 'command'; command: string };
}

/**
 * Convert agent JSON hooks from v2 object format to v3 array format.
 *
 * v2 format: `{ "hooks": { "preToolUse": [{"command":"...","matcher":"shell"}], "postToolUse": [...] } }`
 * v3 format: `{ "hooks": [{"name":"preToolUse-0","trigger":"preToolUse","action":{"type":"command","command":"..."}}] }`
 *
 * If hooks is already an array (v3 format), returns it unchanged (pass-through).
 * If hooks is absent or null, returns undefined (no conversion needed).
 *
 * Safety invariant: this transform is only called when `agentEngine='v3'`, which
 * is set iff `kiroAgentName` is defined. If v2+--agent is ever restored without
 * v3, this function must not be invoked (v2 KAS expects the object format).
 *
 * Limitations:
 * - v2 `matcher` field has no v3 equivalent. Entries with matcher are still
 *   converted (the hook fires for ALL tools), but a warn is emitted so operators
 *   know the filter is lost. When KAS adds matcher support to the v3 schema,
 *   this conversion should be updated to map it.
 */
export const convertHooksV2ToV3 = (hooks: unknown): V3HookEntry[] | undefined => {
  if (hooks === undefined || hooks === null) return undefined;
  if (Array.isArray(hooks)) return hooks as V3HookEntry[];

  if (typeof hooks !== 'object') return undefined;

  const v2Hooks = hooks as Record<string, unknown>;
  const result: V3HookEntry[] = [];
  let totalV2Entries = 0;
  let skippedEntries = 0;
  let matcherDropped = false;

  for (const [trigger, entries] of Object.entries(v2Hooks)) {
    if (!Array.isArray(entries)) continue;
    totalV2Entries += entries.length;
    entries.forEach((entry: unknown, index: number) => {
      if (typeof entry !== 'object' || entry === null) {
        skippedEntries++;
        return;
      }
      const e = entry as Record<string, unknown>;
      const command = typeof e.command === 'string' ? e.command : undefined;
      if (!command) {
        skippedEntries++;
        return;
      }
      if (typeof e.matcher === 'string') {
        matcherDropped = true;
      }
      result.push({
        name: `${trigger}-${index}`,
        trigger,
        action: { type: 'command', command },
      });
    });
  }

  if (matcherDropped) {
    console.warn(
      `[skill-catalogue] v2→v3 hooks conversion: 'matcher' field has no v3 equivalent and was dropped. ` +
        `Hook(s) will fire for ALL tools instead of the matched subset. ` +
        `Affected hooks: ${result
          .filter((_, i) => i < 5)
          .map((h) => h.name)
          .join(', ')}${result.length > 5 ? '...' : ''}`
    );
  }

  if (totalV2Entries > 0 && result.length === 0) {
    console.warn(
      `[skill-catalogue] v2→v3 hooks conversion produced 0 entries from ${totalV2Entries} v2 hook(s). ` +
        `All entries lacked a 'command' field and were skipped. Hooks will be inactive.`
    );
  } else if (skippedEntries > 0) {
    console.warn(
      `[skill-catalogue] v2→v3 hooks conversion: ${skippedEntries} of ${totalV2Entries} entries skipped ` +
        `(missing 'command' field). ${result.length} hook(s) converted successfully.`
    );
  }

  return result.length > 0 ? result : undefined;
};

/**
 * Transform deployed agent JSON files: convert v2-format hooks to v3 array
 * format so KAS (v3 engine) can process them. Reads each .json in the
 * agents directory, applies conversion if needed, and writes back.
 */
export const transformDeployedAgentHooksForV3 = (kiroDest: string): void => {
  const agentsDir = path.join(kiroDest, 'agents');
  if (!fs.existsSync(agentsDir)) return;

  const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    const filePath = path.join(agentsDir, file);
    try {
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (!content.hooks) continue;

      const converted = convertHooksV2ToV3(content.hooks);
      if (converted && !Array.isArray(content.hooks)) {
        content.hooks = converted;
        fs.writeFileSync(filePath, JSON.stringify(content, null, 2));
        console.log(`[skill-catalogue] Converted v2 hooks to v3 format in ${filePath}`);
      }
    } catch {
      // Parse/write failure is non-fatal for hook conversion
    }
  }
};

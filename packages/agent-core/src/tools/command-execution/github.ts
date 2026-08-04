import { exec, spawn } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);

const cache = {
  updatedAt: 0,
  token: '',
};

export const isGitHubConfigured = () => {
  return !!(
    process.env.GITHUB_PERSONAL_ACCESS_TOKEN ||
    (process.env.GITHUB_APP_PRIVATE_KEY_PATH && process.env.GITHUB_APP_ID && process.env.GITHUB_APP_INSTALLATION_ID)
  );
};

export const buildGhLoginEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const { GITHUB_TOKEN, GH_TOKEN, ...rest } = env;
  return rest;
};

const GH_LOGIN_TIMEOUT_MS = 10_000;

const loginGhWithToken = (token: string, env: NodeJS.ProcessEnv): Promise<void> => {
  return new Promise((resolve, reject) => {
    const loginEnv = buildGhLoginEnv(env);
    const proc = spawn('gh', ['auth', 'login', '--hostname', 'github.com', '--with-token'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: loginEnv,
    });
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGKILL');
      reject(new Error(`gh auth login timed out after ${GH_LOGIN_TIMEOUT_MS}ms`));
    }, GH_LOGIN_TIMEOUT_MS);
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`gh auth login failed (code ${code}): ${stderr}`));
    });
    proc.stdin.write(token);
    proc.stdin.end();
  });
};

export const authorizeGitHubCli = async () => {
  if (cache.updatedAt > Date.now() - 50 * 60 * 1000) {
    return cache.token;
  }
  if (process.env.GITHUB_PERSONAL_ACCESS_TOKEN) {
    cache.token = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  } else if (
    process.env.GITHUB_APP_PRIVATE_KEY_PATH &&
    process.env.GITHUB_APP_ID &&
    process.env.GITHUB_APP_INSTALLATION_ID
  ) {
    console.log(`refreshing token...`);
    const { stdout } = await execAsync(
      `gh-token generate --key ${process.env.GITHUB_APP_PRIVATE_KEY_PATH} --app-id ${process.env.GITHUB_APP_ID} --installation-id ${process.env.GITHUB_APP_INSTALLATION_ID}`
    );
    const token = JSON.parse(stdout).token;
    if (!token) {
      throw new Error('Failed to get GitHub token');
    }
    cache.token = token;
  } else {
    return undefined;
  }

  const authEnv = {
    ...process.env,
    GITHUB_TOKEN: cache.token,
  };

  await execAsync(`gh auth setup-git`, { env: authEnv });

  await loginGhWithToken(cache.token, authEnv);

  cache.updatedAt = Date.now();
  return cache.token;
};

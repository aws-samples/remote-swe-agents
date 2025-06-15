import * as core from '@actions/core';
import * as github from '@actions/github';

export async function isCollaborator(user: string, repository: string): Promise<boolean> {
  const [owner, repo] = repository.split('/');
  try {
    const octokit = github.getOctokit(process.env.GITHUB_TOKEN!);
    const res = await octokit.rest.repos.getCollaboratorPermissionLevel({
      owner,
      repo,
      username: user,
    });
    return ['admin', 'write'].includes(res.data.permission);
  } catch (e) {
    core.info(`got error on isCollaborator ${e}. owner: ${owner} repo: ${repo} user: ${user}`);
    return false;
  }
}

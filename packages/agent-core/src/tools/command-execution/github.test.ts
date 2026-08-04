import { describe, it, expect } from 'vitest';
import { buildGhLoginEnv } from './github';

describe('buildGhLoginEnv', () => {
  it('removes GITHUB_TOKEN and GH_TOKEN from env', () => {
    const env = {
      HOME: '/root',
      PATH: '/usr/bin',
      GITHUB_TOKEN: 'ghs_secret123',
      GH_TOKEN: 'ghs_another456',
      OTHER_VAR: 'keep',
    } as unknown as NodeJS.ProcessEnv;

    const result = buildGhLoginEnv(env);

    expect(result).not.toHaveProperty('GITHUB_TOKEN');
    expect(result).not.toHaveProperty('GH_TOKEN');
    expect(result).toHaveProperty('HOME', '/root');
    expect(result).toHaveProperty('PATH', '/usr/bin');
    expect(result).toHaveProperty('OTHER_VAR', 'keep');
  });

  it('works when neither token var is present', () => {
    const env = {
      HOME: '/root',
      PATH: '/usr/bin',
    } as unknown as NodeJS.ProcessEnv;

    const result = buildGhLoginEnv(env);

    expect(result).not.toHaveProperty('GITHUB_TOKEN');
    expect(result).not.toHaveProperty('GH_TOKEN');
    expect(result).toHaveProperty('HOME', '/root');
    expect(result).toHaveProperty('PATH', '/usr/bin');
  });
});

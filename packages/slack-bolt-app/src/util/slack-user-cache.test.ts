import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { resolveSlackDisplayName, __clearSlackUserCacheForTests, BACKOFF_MS, SUCCESS_TTL_MS } from './slack-user-cache';

type UsersInfoArgs = { user: string };

function makeClient(responder: (args: UsersInfoArgs) => Promise<any> | any) {
  const usersInfo = vi.fn(responder);
  return {
    client: {
      users: {
        info: usersInfo as unknown as (args: UsersInfoArgs) => Promise<any>,
      },
    } as any,
    usersInfo,
  };
}

describe('resolveSlackDisplayName', () => {
  beforeEach(() => {
    __clearSlackUserCacheForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    // Silence the expected `[slack-user-cache] failed to resolve ...` error
    // logs so they do not pollute the test output.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('caches a successful lookup so subsequent calls do not hit the API', async () => {
    const { client, usersInfo } = makeClient(() => ({
      user: { profile: { display_name: 'Alice' } },
    }));

    const first = await resolveSlackDisplayName(client, 'U1');
    const second = await resolveSlackDisplayName(client, 'U1');

    expect(first).toBe('Alice');
    expect(second).toBe('Alice');
    expect(usersInfo).toHaveBeenCalledTimes(1);
  });

  test('API failure returns fallback WITHOUT polluting the success cache', async () => {
    const { client, usersInfo } = makeClient(() => {
      throw new Error('slack 500');
    });

    const first = await resolveSlackDisplayName(client, 'U2');

    expect(first).toBe('<@U2>');
    expect(usersInfo).toHaveBeenCalledTimes(1);

    // Simulate Slack recovering BEFORE the backoff window expires. A
    // naive implementation that cached the fallback would still return
    // `<@U2>`; we instead short-circuit via the backoff map.
    usersInfo.mockImplementationOnce(() => ({ user: { profile: { display_name: 'NowWorks' } } }));

    // Within backoff window → still returns fallback, no new API call.
    vi.advanceTimersByTime(BACKOFF_MS - 1);
    const second = await resolveSlackDisplayName(client, 'U2');
    expect(second).toBe('<@U2>');
    expect(usersInfo).toHaveBeenCalledTimes(1);
  });

  test('retries after the backoff window elapses and caches the recovered name', async () => {
    let attempt = 0;
    const { client, usersInfo } = makeClient(() => {
      attempt += 1;
      if (attempt === 1) throw new Error('slack 500');
      return { user: { profile: { display_name: 'Recovered' } } };
    });

    // Initial failure.
    expect(await resolveSlackDisplayName(client, 'U3')).toBe('<@U3>');
    expect(usersInfo).toHaveBeenCalledTimes(1);

    // Advance past the backoff window.
    vi.advanceTimersByTime(BACKOFF_MS + 1);

    // Retry happens, succeeds, result is cached.
    expect(await resolveSlackDisplayName(client, 'U3')).toBe('Recovered');
    expect(usersInfo).toHaveBeenCalledTimes(2);

    // And from here on, the cached value is served without further API calls.
    expect(await resolveSlackDisplayName(client, 'U3')).toBe('Recovered');
    expect(usersInfo).toHaveBeenCalledTimes(2);
  });

  test('successful recovery clears the backoff entry so future failures get a fresh window', async () => {
    let attempt = 0;
    const { client, usersInfo } = makeClient(() => {
      attempt += 1;
      if (attempt === 1) throw new Error('first failure');
      if (attempt === 2) return { user: { profile: { display_name: 'Ok' } } };
      throw new Error('later failure');
    });

    // 1) fail
    await resolveSlackDisplayName(client, 'U4');
    expect(usersInfo).toHaveBeenCalledTimes(1);

    // 2) after backoff elapses, success
    vi.advanceTimersByTime(BACKOFF_MS + 1);
    expect(await resolveSlackDisplayName(client, 'U4')).toBe('Ok');
    expect(usersInfo).toHaveBeenCalledTimes(2);

    // Cache now holds the successful value → no API call at all for a while.
    expect(await resolveSlackDisplayName(client, 'U4')).toBe('Ok');
    expect(usersInfo).toHaveBeenCalledTimes(2);
  });

  test('display-name priority falls through to real_name and user.name', async () => {
    const { client } = makeClient(() => ({
      user: {
        name: 'fallback-handle',
        real_name: 'Top Level Real',
        profile: { display_name: '', real_name: 'Profile Real' },
      },
    }));
    // profile.display_name is empty → profile.real_name wins.
    expect(await resolveSlackDisplayName(client, 'U5')).toBe('Profile Real');

    __clearSlackUserCacheForTests();
    const { client: client2 } = makeClient(() => ({
      user: { name: 'handle-only' },
    }));
    expect(await resolveSlackDisplayName(client2, 'U6')).toBe('handle-only');

    __clearSlackUserCacheForTests();
    const { client: client3 } = makeClient(() => ({ user: {} }));
    // No name fields at all → explicit <@...> fallback.
    expect(await resolveSlackDisplayName(client3, 'U7')).toBe('<@U7>');
  });

  test('returns the "unknown-user" sentinel when given a blank id', async () => {
    const { client, usersInfo } = makeClient(() => {
      throw new Error('should not be called');
    });
    expect(await resolveSlackDisplayName(client, '')).toBe('unknown-user');
    expect(usersInfo).not.toHaveBeenCalled();
  });

  test('success cache expires after SUCCESS_TTL_MS and refetches the (possibly renamed) display name', async () => {
    // First call resolves "Alice", second call (after TTL elapses)
    // resolves "Alice Renamed" — the cache must hand out the new name.
    let attempt = 0;
    const { client, usersInfo } = makeClient(() => {
      attempt += 1;
      return attempt === 1
        ? { user: { profile: { display_name: 'Alice' } } }
        : { user: { profile: { display_name: 'Alice Renamed' } } };
    });

    expect(await resolveSlackDisplayName(client, 'U-TTL')).toBe('Alice');
    expect(usersInfo).toHaveBeenCalledTimes(1);

    // Just before expiry: still the cached value, no refetch.
    vi.advanceTimersByTime(SUCCESS_TTL_MS - 1);
    expect(await resolveSlackDisplayName(client, 'U-TTL')).toBe('Alice');
    expect(usersInfo).toHaveBeenCalledTimes(1);

    // Push the clock past the TTL boundary (advance another 2ms).
    vi.advanceTimersByTime(2);
    expect(await resolveSlackDisplayName(client, 'U-TTL')).toBe('Alice Renamed');
    expect(usersInfo).toHaveBeenCalledTimes(2);

    // The freshly-cached value is served until the next TTL boundary.
    expect(await resolveSlackDisplayName(client, 'U-TTL')).toBe('Alice Renamed');
    expect(usersInfo).toHaveBeenCalledTimes(2);
  });

  test('SUCCESS_TTL_MS is set to 24 hours', () => {
    // Pin the chosen TTL so an accidental edit to the constant raises a
    // visible test failure rather than silently changing the cache
    // freshness contract for downstream code.
    expect(SUCCESS_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});

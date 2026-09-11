import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@remote-swe-agents/agent-core/lib', () => ({
  sendSystemMessage: vi.fn(),
  updateInstanceStatus: vi.fn(),
}));
vi.mock('./ec2', () => ({ stopMyself: vi.fn() }));
vi.mock('./notify-termination', () => ({ notifyTermination: vi.fn() }));
vi.mock('../runtime-type', () => ({ getProcessRuntimeType: () => 'ec2' }));
vi.mock('@remote-swe-agents/agent-core/tools', () => ({ terminatePreview: vi.fn() }));

import { setKillTimer, pauseKillTimer, restartKillTimer } from './kill-timer';
import { stopMyself } from './ec2';

describe('kill-timer race prevention', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pause before main prevents residual timer from firing', () => {
    setKillTimer('old-worker');
    vi.advanceTimersByTime(28 * 60 * 1000);

    pauseKillTimer();

    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(stopMyself).not.toHaveBeenCalled();
  });

  it('restart after pause re-arms the 30 min timer', async () => {
    const token = pauseKillTimer();
    restartKillTimer('new-worker', token);

    await vi.advanceTimersByTimeAsync(29 * 60 * 1000);
    expect(stopMyself).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(stopMyself).toHaveBeenCalledWith('new-worker');
  });
});

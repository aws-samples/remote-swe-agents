import { describe, it, expect } from 'vitest';
import { CancellationToken } from './cancellation-token';

describe('CancellationToken', () => {
  it('fires onCancel listener synchronously when cancel() is called', () => {
    const token = new CancellationToken();
    let fired = false;
    token.onCancel(() => {
      fired = true;
    });
    expect(fired).toBe(false);
    token.cancel();
    expect(fired).toBe(true);
    expect(token.isCancelled).toBe(true);
  });

  it('fires listener immediately if already cancelled', () => {
    const token = new CancellationToken();
    token.cancel();
    let fired = false;
    token.onCancel(() => {
      fired = true;
    });
    expect(fired).toBe(true);
  });

  it('unsubscribe prevents listener from firing', () => {
    const token = new CancellationToken();
    let fired = false;
    const unsub = token.onCancel(() => {
      fired = true;
    });
    unsub();
    token.cancel();
    expect(fired).toBe(false);
  });

  it('does not throw if listener throws', () => {
    const token = new CancellationToken();
    let secondFired = false;
    token.onCancel(() => {
      throw new Error('boom');
    });
    token.onCancel(() => {
      secondFired = true;
    });
    expect(() => token.cancel()).not.toThrow();
    expect(secondFired).toBe(true);
  });

  it('supports multiple listeners', () => {
    const token = new CancellationToken();
    const calls: number[] = [];
    token.onCancel(() => calls.push(1));
    token.onCancel(() => calls.push(2));
    token.cancel();
    expect(calls).toEqual([1, 2]);
  });

  it('completeCancel invokes the callback passed to cancel()', async () => {
    const token = new CancellationToken();
    let called = false;
    token.cancel(async () => {
      called = true;
    });
    await token.completeCancel();
    expect(called).toBe(true);
  });

  it('does not throw if immediate-fire listener throws on already-cancelled token', () => {
    const token = new CancellationToken();
    token.cancel();
    expect(() =>
      token.onCancel(() => {
        throw new Error('boom-immediate');
      })
    ).not.toThrow();
  });

  it('cancel() is idempotent: listeners fire at most once and callback is preserved', async () => {
    const token = new CancellationToken();
    let fireCount = 0;
    let firstCallbackCalls = 0;
    let secondCallbackCalls = 0;
    token.onCancel(() => {
      fireCount++;
    });
    token.cancel(async () => {
      firstCallbackCalls++;
    });
    token.cancel(async () => {
      secondCallbackCalls++;
    });
    token.cancel();
    expect(fireCount).toBe(1);
    await token.completeCancel();
    expect(firstCallbackCalls).toBe(1);
    expect(secondCallbackCalls).toBe(0);
  });
});

import { describe, expect, test, vi } from 'vitest';
import { runDeleteSuccessNavigation } from './delete-navigation';

describe('runDeleteSuccessNavigation', () => {
  test('when onDeleted is provided: it is called once and refresh is NOT called', () => {
    const refresh = vi.fn();
    const onDeleted = vi.fn();
    const onSuccess = vi.fn();

    runDeleteSuccessNavigation({ refresh }, { onDeleted, onSuccess });

    expect(onDeleted).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  test('when onDeleted is absent: refresh is called and onSuccess is invoked', () => {
    const refresh = vi.fn();
    const onSuccess = vi.fn();

    runDeleteSuccessNavigation({ refresh }, { onSuccess });

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  test('when onDeleted is absent and onSuccess is also absent: refresh is called without throwing', () => {
    const refresh = vi.fn();

    expect(() => runDeleteSuccessNavigation({ refresh }, {})).not.toThrow();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

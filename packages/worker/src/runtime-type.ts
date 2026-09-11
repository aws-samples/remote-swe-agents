import type { RuntimeType } from '@remote-swe-agents/agent-core/schema';

let _processRuntimeType: RuntimeType | undefined;

export const setProcessRuntimeType = (type: RuntimeType): void => {
  _processRuntimeType = type;
};

export const getProcessRuntimeType = (): RuntimeType | undefined => {
  return _processRuntimeType ?? (process.env.WORKER_RUNTIME as RuntimeType | undefined);
};

/** Reset to undefined. Only for use in test suites. */
export const _resetProcessRuntimeTypeForTesting = (): void => {
  _processRuntimeType = undefined;
};

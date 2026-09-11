export const MAX_CONSECUTIVE_ERRORS = 3;

export const categorizeError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const lowerMessage = message.toLowerCase();

  if (lowerMessage.includes('max tokens exceeded too many times')) {
    return 'max_output_tokens_exceeded';
  }
  if (lowerMessage.includes('throttl')) {
    return 'throttling';
  }
  if (lowerMessage.includes('validationexception') || lowerMessage.includes('validation')) {
    return 'validation_error';
  }
  if (lowerMessage.includes('modelerrorexception') || lowerMessage.includes('model error')) {
    return 'model_error';
  }
  if (
    lowerMessage.includes('serviceunavaila') ||
    lowerMessage.includes('internalservererror') ||
    lowerMessage.includes('internal server')
  ) {
    return 'service_unavailable';
  }
  if (lowerMessage.includes('accessdenied') || lowerMessage.includes('access denied')) {
    return 'access_denied';
  }
  if (lowerMessage.includes('timeout') || lowerMessage.includes('timed out')) {
    return 'timeout';
  }
  return 'unknown_error';
};

export const getRecoveryHint = (errorType: string, errorMessage: string): string => {
  switch (errorType) {
    case 'max_output_tokens_exceeded':
      return 'Recovery hint: Your previous output was too long and exceeded the maximum output token limit even after multiple retries with increased limits. Please significantly reduce your output length. Break your response into smaller parts, use tools to write to files instead of outputting large content directly, and avoid generating very long code blocks or explanations in a single response.';
    case 'throttling':
      return 'Recovery hint: The API is being rate-limited. This is usually temporary. Please continue with your task - the system will automatically retry.';
    case 'validation_error':
      return `Recovery hint: The request was rejected due to a validation error. This may be caused by malformed input or unsupported content. Please review your last action and try a different approach. Details: ${errorMessage}`;
    case 'model_error':
      return 'Recovery hint: The model encountered an internal error processing your request. This can happen with very complex inputs. Try simplifying your approach or breaking the task into smaller steps.';
    case 'service_unavailable':
      return 'Recovery hint: The service is temporarily unavailable. Please continue with your task - the system will automatically retry.';
    case 'access_denied':
      return 'Recovery hint: Access was denied. This might be a permissions issue. Please notify the user about this error.';
    case 'timeout':
      return 'Recovery hint: The request timed out. Try reducing the complexity of your current operation or breaking it into smaller steps.';
    default:
      return `Recovery hint: An unexpected error occurred. Please try a different approach or simplify your current task. If this persists, notify the user.`;
  }
};

export const isPermanentError = (errorType: string, errorMessage: string): boolean => {
  if (errorType === 'validation_error') return true;
  const lower = errorMessage.toLowerCase();
  if (lower.includes('invalid_request_error')) return true;
  if (lower.includes('image dimensions exceed')) return true;
  return false;
};

export const getPermanentErrorHint = (errorMessage: string): string => {
  const lower = errorMessage.toLowerCase();
  if (lower.includes('image dimensions exceed') || (lower.includes('image') && lower.includes('size'))) {
    return 'An image in this conversation is too large. Please try again in a new session.';
  }
  if (lower.includes('invalid_request_error') || lower.includes('validation')) {
    return 'The request violated a model API constraint.';
  }
  return 'The request was permanently rejected.';
};

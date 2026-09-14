import { describe, it, expect } from 'vitest';
import { prettifyToolName, normalizeToolName, toolNamesEqual, toolNameInSet } from './index';

describe('prettifyToolName', () => {
  it('converts Bedrock-sanitized Title_Case to spaced form', () => {
    expect(prettifyToolName('Execute_Command')).toBe('Execute Command');
    expect(prettifyToolName('Send_Message_To_User')).toBe('Send Message To User');
    expect(prettifyToolName('File_Editor')).toBe('File Editor');
    expect(prettifyToolName('Get_PR_Comments')).toBe('Get PR Comments');
    expect(prettifyToolName('Clone_GitHub_Repository')).toBe('Clone GitHub Repository');
    expect(prettifyToolName('Todo_Init')).toBe('Todo Init');
  });

  it('leaves snake_case kiro native tools unchanged', () => {
    expect(prettifyToolName('execute_bash')).toBe('execute_bash');
    expect(prettifyToolName('str_replace')).toBe('str_replace');
    expect(prettifyToolName('read_file')).toBe('read_file');
    expect(prettifyToolName('list_directory')).toBe('list_directory');
  });

  it('leaves already-spaced names unchanged', () => {
    expect(prettifyToolName('Execute Command')).toBe('Execute Command');
    expect(prettifyToolName('Send Message To User')).toBe('Send Message To User');
  });

  it('leaves camelCase names unchanged', () => {
    expect(prettifyToolName('executeCommand')).toBe('executeCommand');
    expect(prettifyToolName('sendMessageToUser')).toBe('sendMessageToUser');
  });

  it('handles single-word Title Case', () => {
    expect(prettifyToolName('Think')).toBe('Think');
  });
});

describe('normalizeToolName', () => {
  it('normalizes spaces, underscores, hyphens to _ + lowercase', () => {
    expect(normalizeToolName('Send Message To User')).toBe('send_message_to_user');
    expect(normalizeToolName('Send_Message_To_User')).toBe('send_message_to_user');
    expect(normalizeToolName('send-message-to-user')).toBe('send_message_to_user');
  });
});

describe('toolNamesEqual', () => {
  it('treats space/underscore/hyphen variants as equal', () => {
    expect(toolNamesEqual('Send Message To User', 'Send_Message_To_User')).toBe(true);
    expect(toolNamesEqual('Execute Command', 'execute_command')).toBe(true);
  });

  it('returns false for different names', () => {
    expect(toolNamesEqual('Execute Command', 'File Editor')).toBe(false);
  });
});

describe('toolNameInSet', () => {
  it('matches normalized names in set', () => {
    const set = new Set(['Send Message To User', 'Execute Command']);
    expect(toolNameInSet('Send_Message_To_User', set)).toBe(true);
    expect(toolNameInSet('execute_command', set)).toBe(true);
    expect(toolNameInSet('File Editor', set)).toBe(false);
  });
});

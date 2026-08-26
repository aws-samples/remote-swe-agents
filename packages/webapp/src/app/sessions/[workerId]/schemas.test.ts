import { describe, expect, test } from 'vitest';
import { sendMessageToAgentSchema } from './schemas';

describe('sendMessageToAgentSchema', () => {
  test('strips localImageUrls so blob URLs can never reach the server / DynamoDB', () => {
    // `MessageView.localImageUrls` is a memory-only field for the optimistic
    // bubble's instant image preview. This test pins the guarantee that even
    // if a caller passes it alongside the form values, the server action
    // input schema drops it — the persisted MessageItem is built exclusively
    // from the parsed input, so blob: URLs can never be written to DynamoDB
    // (which would break after any reload, as blob URLs die with the page).
    const parsed = sendMessageToAgentSchema.parse({
      workerId: 'worker-1',
      message: 'hello',
      imageKeys: ['worker-1/img.png'],
      localImageUrls: { 'worker-1/img.png': 'blob:https://example/xyz' },
    });
    expect(parsed.imageKeys).toEqual(['worker-1/img.png']);
    expect('localImageUrls' in parsed).toBe(false);
  });
});

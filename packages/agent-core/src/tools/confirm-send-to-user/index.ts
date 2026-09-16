import { savePendingState, loadAndDeletePendingState, createConfirmTool } from '../child-guard';
import { sendMessageToUser } from '../report-progress';

const PENDING_KEY = 'user-message';

export const savePendingUserMessage = (workerId: string, message: string) => {
  savePendingState(PENDING_KEY, workerId, message);
};

export const loadAndDeletePendingUserMessage = (workerId: string): string | undefined => {
  return loadAndDeletePendingState(PENDING_KEY, workerId);
};

export const confirmSendToUserTool = createConfirmTool({
  name: 'confirmSendToUser',
  description: `Confirm and send a blocked sendMessageToUser call in a child session. Call this after sendMessageToUser returns a confirmation prompt. If you do not want to send the message, simply do not call this tool.`,
  pendingKey: PENDING_KEY,
  noPendingMessage: 'No pending message to confirm. Use sendMessageToUser first.',
  execute: async (workerId: string, pendingData: string) => {
    await sendMessageToUser(workerId, pendingData);
    return 'Successfully sent the message to the user.';
  },
});

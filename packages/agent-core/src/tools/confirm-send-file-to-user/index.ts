import { createConfirmTool } from '../child-guard';
import { sendFileToUser } from '../send-file';

const PENDING_KEY = 'user-file';

export const confirmSendFileToUserTool = createConfirmTool({
  name: 'confirm_send_file_to_user',
  description: `Confirm and send a blocked send_file_to_user call in a child session. Call this after send_file_to_user returns a confirmation prompt. If you do not want to send the file, simply do not call this tool.`,
  pendingKey: PENDING_KEY,
  execute: async (workerId: string, pendingData: string) => {
    const { filePath, message } = JSON.parse(pendingData);
    const toolUseId = `confirm-file-${Date.now()}`;
    return sendFileToUser(filePath, message, { workerId, toolUseId });
  },
});

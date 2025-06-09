import { reportProgressTool } from '../tools/report-progress';

export const renderToolResult = (props: { toolResult: string; forceReport: boolean }) => {
  return `
<result>
${props.toolResult}
</result>
<command>
${props.forceReport ? `Long time has passed since you sent the last message. Please use ${reportProgressTool.name} tool to send a response asap.` : ''}
</command>
`.trim();
};

export const renderUserMessage = async (props: { message: string }) => {
  // Import and use the prompt modifier if available
  let modifiedMessage = props.message;
  try {
    const promptModifiers = require('./prompt-modifiers');
    if (promptModifiers && promptModifiers.modifyUserMessage) {
      modifiedMessage = await promptModifiers.modifyUserMessage(props.message);
    }
  } catch (error) {
    console.error('Error applying user message modifier:', error);
  }

  return `
<user_message>
${modifiedMessage}
</user_message>
<command>
User sent you a message. Please use ${reportProgressTool.name} tool to send a response asap.
</command>
`.trim();
};

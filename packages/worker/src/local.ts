import { createInterface } from 'readline';
import { onMessageReceived } from './agent';
import { WorkerId } from '@remote-swe-agents/agent-core/env';
import { renderUserMessage, saveConversationHistory } from '@remote-swe-agents/agent-core/lib';
import { CancellationToken } from './common/cancellation-token';
import './common/signal-handler';

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});
const workerId = WorkerId;

async function processInput(input: string) {
  try {
    if (input) {
      await saveConversationHistory(
        workerId,
        {
          role: 'user',
          content: [{ text: renderUserMessage({ message: input }) }],
        },
        0,
        'userMessage'
      );
    }
    await onMessageReceived(workerId, new CancellationToken());
  } catch (error) {
    console.error('An error occurred:', error);
  }
  rl.question('Enter your message: ', processInput);
}

console.log(`Local worker started. workerId: ${workerId}`);
rl.question('Enter your message: ', processInput);

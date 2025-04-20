import { stopMyself } from './aws/ec2';
import { sendMessageToSlack } from './slack';

let killTimer: NodeJS.Timeout;
export const setKillTimer = () => {
  if (killTimer) {
    clearTimeout(killTimer);
  }
  killTimer = setTimeout(
    async () => {
      await sendMessageToSlack('Going to sleep mode. You can wake me up at any time.');
      await stopMyself();
    },
    30 * 60 * 1000
  );
};

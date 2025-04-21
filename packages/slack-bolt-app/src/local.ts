import { exit } from 'process';
import app from './app';

const isTest = process.env.TESTING_BOOTSTRAP;

(async () => {
  // Initialize and start your app
  await app.start(process.env.PORT || 3000);

  console.log('⚡️ Bolt app is running!');

  if (isTest == 'true') {
    console.log('Successfully booted the api.');
    exit(0);
  }
})();

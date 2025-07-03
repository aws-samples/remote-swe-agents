/**
 * This script starts the DynamoDB Local container, sets up the table,
 * and then starts the local worker.
 */

import { spawn } from 'child_process';
import { setupDynamoDBLocal } from './setup-dynamodb-local';

// Default environment variables
const defaultEnv = {
  DYNAMODB_ENDPOINT: 'http://localhost:8000',
  TABLE_NAME: 'RemoteSWEAgentsTable-local',
};

/**
 * Starts the local worker
 */
async function startLocalWorker(): Promise<void> {
  console.log('Starting local worker...');

  // Set environment variables
  const env = { ...defaultEnv, ...process.env };

  const worker = spawn('npm', ['run', 'start:local'], {
    stdio: 'inherit',
    env,
  });

  return new Promise((resolve, reject) => {
    worker.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Worker exited with code ${code}`));
      }
    });

    worker.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Main function
 */
async function main(): Promise<void> {
  try {
    // Setup DynamoDB Local
    await setupDynamoDBLocal();

    // Start local worker
    await startLocalWorker();
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

// If this script is run directly
if (require.main === module) {
  main().catch((err) => console.error('Error:', err));
}

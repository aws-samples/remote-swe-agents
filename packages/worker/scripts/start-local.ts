/**
 * This script starts the DynamoDB Local container, sets up the table,
 * and then starts the local worker.
 */

import { spawn, exec } from 'child_process';
import path from 'path';
import { promisify } from 'util';
import { setupDynamoDBLocal } from './setup-dynamodb-local';

const execPromise = promisify(exec);

// Path to the repository root
const repoRoot = path.resolve(__dirname, '..', '..', '..');

// Default environment variables
const defaultEnv = {
  DYNAMODB_ENDPOINT: 'http://localhost:8000',
  TABLE_NAME: 'RemoteSWEAgentsTable-local',
  AWS_REGION: 'ap-northeast-1',
  AWS_ACCESS_KEY_ID: 'local',
  AWS_SECRET_ACCESS_KEY: 'local',
  WORKER_ID: 'local-worker',
};

/**
 * Checks if DynamoDB Local is running
 */
async function isDynamoDBRunning(): Promise<boolean> {
  try {
    await execPromise('curl -s http://localhost:8000');
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Starts DynamoDB Local using Docker Compose
 */
async function startDynamoDBLocal(): Promise<void> {
  console.log('Starting DynamoDB Local using Docker Compose...');

  const dockerCompose = spawn('docker-compose', ['up', '-d', 'dynamodb-local', 'dynamodb-admin'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });

  return new Promise((resolve, reject) => {
    dockerCompose.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Docker Compose exited with code ${code}`));
      }
    });

    dockerCompose.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Waits for DynamoDB Local to be ready
 */
async function waitForDynamoDB(): Promise<void> {
  console.log('Waiting for DynamoDB Local to start...');

  let retries = 0;
  const maxRetries = 30;

  while (retries < maxRetries) {
    if (await isDynamoDBRunning()) {
      console.log('DynamoDB Local is running');
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
    process.stdout.write('.');
    retries++;
  }

  throw new Error('Timeout waiting for DynamoDB Local to start');
}

/**
 * Builds agent-core
 */
async function buildAgentCore(): Promise<void> {
  console.log('Building agent-core...');

  const build = spawn('npm', ['run', 'build', '-w', '@remote-swe-agents/agent-core'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });

  return new Promise((resolve, reject) => {
    build.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Build exited with code ${code}`));
      }
    });

    build.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Starts the local worker
 */
async function startLocalWorker(): Promise<void> {
  console.log('Starting local worker...');

  // Set environment variables
  const env = { ...process.env, ...defaultEnv };

  const worker = spawn('npm', ['run', 'start:local'], {
    cwd: path.join(repoRoot, 'packages', 'worker'),
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
    // Check if DynamoDB Local is running
    if (await isDynamoDBRunning()) {
      console.log('DynamoDB Local is already running');
    } else {
      await startDynamoDBLocal();
      await waitForDynamoDB();
    }

    // Setup DynamoDB Local
    await setupDynamoDBLocal();

    // Build agent-core
    await buildAgentCore();

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

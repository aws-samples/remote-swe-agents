import { afterAll, beforeAll, expect, test } from 'vitest';
import { fileEditTool } from './';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

const tempDirPath = join(tmpdir(), `worker-test-${randomBytes(6).toString('hex')}`);
beforeAll(async () => {
  mkdirSync(tempDirPath);
});

afterAll(async () => {
  rmSync(tempDirPath, { recursive: true, force: true });
});

test('success replace', () => {
  // GIVEN
  const tool = fileEditTool.handler;
  const file = `
interface Vehicle {
    brand: string;
    year: number;
    isElectric: boolean;
}

function displayVehicleInfo(vehicle: Vehicle): void {
    if (vehicle.isElectric) {
        console.log(vehicle.brand + ' (' + vehicle.year + ') - Electric Vehicle');
    } else {
        console.log(vehicle.brand + ' (' + vehicle.year + ') - Combustion Engine');
    }
}
`;
  const filePath = join(tempDirPath, `${randomBytes(6).toString('hex')}.ts`);
  writeFileSync(filePath, file, 'utf-8');

  // WHEN
  tool(
    {
      filePath,
      oldString: `
function displayVehicleInfo(vehicle: Vehicle): void {
    if (vehicle.isElectric) {
        console.log(vehicle.brand + ' (' + vehicle.year + ') - Electric Vehicle');`,
      newString: `
function displayVehicleInfo(vehicle: Vehicle) {
    if (vehicle.isElectric) {
        console.log('Electric Vehicle');`,
    },
    { toolUseId: 'dummy' }
  );
  const newFile = readFileSync(filePath, 'utf-8');

  // THEN
  expect(newFile).toEqual(`
interface Vehicle {
    brand: string;
    year: number;
    isElectric: boolean;
}

function displayVehicleInfo(vehicle: Vehicle) {
    if (vehicle.isElectric) {
        console.log('Electric Vehicle');
    } else {
        console.log(vehicle.brand + ' (' + vehicle.year + ') - Combustion Engine');
    }
}
`);
});

test('create new file with empty oldString', async () => {
  // GIVEN
  const tool = fileEditTool.handler;
  const newContent = `
interface User {
    id: number;
    name: string;
    email: string;
}

function getUserDisplayName(user: User): string {
    return \`\${user.name} <\${user.email}>\`;
}
`;
  const filePath = join(tempDirPath, `${randomBytes(6).toString('hex')}.ts`);

  // Ensure file doesn't exist before test
  expect(existsSync(filePath)).toBe(false);

  // WHEN
  const result = await tool(
    {
      filePath,
      oldString: '',
      newString: newContent,
    },
    { toolUseId: 'dummy' }
  );

  // THEN
  expect(result).toBe('successfully created the file.');
  expect(existsSync(filePath)).toBe(true);

  const fileContent = readFileSync(filePath, 'utf-8');
  expect(fileContent).toEqual(newContent);
});

test('error when file exists and oldString is empty', async () => {
  // GIVEN
  const tool = fileEditTool.handler;
  const existingContent = `
const config = {
    apiUrl: 'https://api.example.com',
    timeout: 30000,
    retries: 3
};
`;
  const filePath = join(tempDirPath, `${randomBytes(6).toString('hex')}.ts`);

  // Create file before test
  writeFileSync(filePath, existingContent, 'utf-8');
  expect(existsSync(filePath)).toBe(true);

  // WHEN
  const result = await tool(
    {
      filePath,
      oldString: '',
      newString: 'new content that should not be written',
    },
    { toolUseId: 'dummy' }
  );

  // THEN
  expect(result).toBe('The file already exists. Please provide a non-empty oldString to edit it.');

  // File content should remain unchanged
  const fileContent = readFileSync(filePath, 'utf-8');
  expect(fileContent).toEqual(existingContent);
});

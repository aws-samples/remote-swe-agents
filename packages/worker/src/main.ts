/**
 * Entrypoint for EC2. This file is named `main.ts` for backward compatibility.
 */
import { main } from './entry';

main(process.env.WORKER_ID!);

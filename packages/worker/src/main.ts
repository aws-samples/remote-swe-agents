/**
 * Entrypoint for EC2. This file is named `main.ts` for backward compatibility.
 */
import { main } from './entry';
import { setProcessRuntimeType } from './runtime-type';

setProcessRuntimeType('ec2');

main(process.env.WORKER_ID!);

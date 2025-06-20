import { setTimeout } from 'timers/promises';

export async function GET() {
  await setTimeout(200);
  return new Response('ok', { status: 200 });
}

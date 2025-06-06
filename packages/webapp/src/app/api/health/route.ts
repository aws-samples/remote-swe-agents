export async function GET() {
  console.log('health ok')
  return new Response('ok', { status: 200 });
}

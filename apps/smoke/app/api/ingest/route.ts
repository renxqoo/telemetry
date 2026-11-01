export const dynamic = 'force-dynamic';
export async function POST(request: Request): Promise<Response> {
  const upstream = process.env.TELEMETRY_SMOKE_COLLECTOR;
  if (!upstream) return Response.json({ error: 'Smoke collector unavailable' }, { status: 503 });
  const origin = request.headers.get('origin');
  if (!origin) return Response.json({ error: 'Origin required' }, { status: 400 });
  const response = await fetch(`${upstream}/v1/ingest/browser`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: await request.text(),
    signal: AbortSignal.timeout(4000),
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}

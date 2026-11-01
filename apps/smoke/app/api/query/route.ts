export const dynamic = 'force-dynamic';
export async function GET(request: Request): Promise<Response> {
  const upstream = process.env.TELEMETRY_SMOKE_QUERY;
  const token = process.env.TELEMETRY_SMOKE_READ_TOKEN;
  if (!upstream || !token)
    return Response.json({ error: 'Smoke query unavailable' }, { status: 503 });
  const query = new URL(request.url).searchParams;
  query.set('environment', 'test');
  query.set('limit', '500');
  const response = await fetch(`${upstream}/v1/events?${query.toString()}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(4000),
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
}

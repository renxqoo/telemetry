export const dynamic = 'force-dynamic';
export function GET(): Response {
  throw new Error('Private test failure text must never be uploaded');
}

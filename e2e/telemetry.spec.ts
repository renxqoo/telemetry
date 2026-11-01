import { expect, test } from '@playwright/test';
import type { EventPage } from '../packages/protocol/src/types.js';
test('browser SDK persists errors and immutable identities, then closes all collection', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Track identities' }).click();
  await expect(page.getByTestId('result')).toContainText('acknowledgedIds');
  await page.getByRole('button', { name: 'Capture error', exact: true }).click();
  await page.getByRole('button', { name: 'Window error', exact: true }).click();
  await page.getByRole('button', { name: 'Reject promise' }).click();
  await page.getByRole('button', { name: 'Render error' }).click();
  await expect(page.getByText('Rendering failure captured')).toBeVisible();
  await page.getByRole('button', { name: 'Flush', exact: true }).click();
  await expect
    .poll(async () => {
      const response = await request.get('/api/query');
      expect(response.status()).toBe(200);
      const result = (await response.json()) as EventPage;
      return result.items.filter((item) => item.source === 'browser').length;
    })
    .toBeGreaterThanOrEqual(6);
  const result = (await (await request.get('/api/query')).json()) as EventPage;
  const before = result.items.find((item) => item.properties.action === 'before-reset');
  const after = result.items.find((item) => item.properties.action === 'after-reset');
  expect(before?.context?.user_id).toBe('user-a');
  expect(after?.context?.user_id).toBeUndefined();
  expect(before?.context?.session_id).not.toBe(after?.context?.session_id);
  const mechanisms = result.items
    .filter((item) => item.kind === 'error')
    .map((item) => item.error?.mechanism);
  expect(mechanisms).toEqual(
    expect.arrayContaining(['manual', 'window_error', 'unhandled_rejection', 'react_boundary']),
  );
  expect(JSON.stringify(result)).not.toContain('Private');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByTestId('result')).toContainText('"state":"closed"');
  await expect(page.getByTestId('result')).toContainText('"after":null');
});
test('Next request error hook persists a sanitized server error', async ({ request }) => {
  const failure = await request.get('/api/failure');
  expect(failure.status()).toBe(500);
  await expect
    .poll(async () => {
      const result = (await (await request.get('/api/query?source=server')).json()) as EventPage;
      return result.items.some(
        (item) =>
          item.error?.mechanism === 'next_request' && item.context?.route === '/api/failure',
      );
    })
    .toBe(true);
});

import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import type { Envelope } from '../packages/protocol/src/types.js';

let source: string;
test.beforeAll(async () => {
  const bundle = await build({
    entryPoints: ['packages/sdk/src/browser.ts'],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'TelemetrySDK',
    platform: 'browser',
  });
  source = bundle.outputFiles[0].text;
});

for (const mode of ['initial-base', 'changed-base', 'beacon']) {
  test(`regression: browser relative endpoints remain on the page origin with ${mode}`, async ({
    page,
  }) => {
    const requests: { origin: string; path: string; id: string; userId?: string }[] = [];
    await page.route('**/*', async (route) => {
      const request = route.request();
      const cors = {
        'access-control-allow-origin': 'https://application.example',
        'access-control-allow-headers': 'content-type',
        'access-control-allow-methods': 'POST',
        'access-control-allow-credentials': 'true',
      };
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (request.method() === 'POST') {
        const body = request.postDataJSON() as Envelope;
        const url = new URL(request.url());
        requests.push({
          origin: url.origin,
          path: url.pathname,
          id: body.events[0].id,
          userId: body.events[0].context?.user_id,
        });
        return route.fulfill({
          status: 200,
          headers: { ...cors, 'content-type': 'application/json' },
          body: JSON.stringify({
            request_id: 'ee31edb7-81b7-4c6d-afba-225a54f1c4b5',
            project_id: '0fcff045-b764-4f86-a82d-5b999b4b8a4f',
            environment: body.environment,
            service: body.service,
            source: 'browser',
            acknowledged: body.events.map((event) => ({
              id: event.id,
              status: 'stored',
              received_at: '2026-11-01T02:00:01.000Z',
              retain_until: '2026-12-01T02:00:01.000Z',
            })),
          }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><title>SDK endpoint</title>',
      });
    });
    await page.goto('https://application.example/sdk-endpoint');
    await page.addScriptTag({ content: source });
    const state = await page.evaluateHandle((mode) => {
      const base = document.createElement('base');
      base.href = mode === 'initial-base' ? 'https://cross-origin.example/assets/' : location.href;
      document.head.append(base);
      const sdk = (
        globalThis as unknown as {
          TelemetrySDK: typeof import('../packages/sdk/src/browser.js');
        }
      ).TelemetrySDK;
      const client = sdk.createBrowserClient({
        endpoints: ['/api/ingest'],
        projectKey: 'pub_endpoint',
        environment: 'test',
        service: 'web',
        release: '1',
        buildId: '1',
        events: { viewed: {} },
        captureGlobalErrors: false,
      });
      if (mode !== 'initial-base') base.href = 'https://cross-origin.example/assets/';
      const id = client.track('viewed', {}, { userId: 'opaque-user' });
      if (id === null) throw new Error('Event was not accepted');
      return { client, id };
    }, mode);
    try {
      const id = await state.evaluate(({ id }) => id);
      if (mode === 'beacon') await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
      else
        expect(
          await state.evaluate(async ({ client, id }) =>
            (await client.flush({ timeoutMs: 2000 })).acknowledgedIds.includes(id),
          ),
        ).toBe(true);
      await expect.poll(() => requests.length).toBe(1);
      expect(requests).toEqual([
        { origin: 'https://application.example', path: '/api/ingest', id, userId: 'opaque-user' },
      ]);
    } finally {
      await state.evaluate(({ client }) => client.close({ timeoutMs: 0 }));
      await state.dispose();
    }
  });
}

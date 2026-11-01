'use client';
import { useEffect, useState } from 'react';
import { TelemetryErrorBoundary } from '@oneaster/telemetry/react';
import type { BrowserClient } from '../../../packages/sdk/src/types.js';
import { getSmokeClient } from '../telemetry';
function Broken(): never {
  throw new Error('Private rendering failure');
}
export default function SmokePage() {
  const [client, setClient] = useState<BrowserClient>();
  const [result, setResult] = useState('ready');
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    setClient(getSmokeClient());
  }, []);
  async function action(kind: string) {
    if (!client) return;
    if (kind === 'track') {
      client.setUser('user-a');
      client.track('smoke_event', { action: 'before-reset' });
      client.reset();
      client.track('smoke_event', { action: 'after-reset' });
    }
    if (kind === 'manual')
      client.captureError(new Error('Private credential text'), {
        operation: 'smoke',
        requestId: 'smoke-manual',
      });
    if (kind === 'close') {
      const closed = await client.close({ timeoutMs: 2000 });
      setResult(
        JSON.stringify({
          closed,
          diagnostics: client.getDiagnostics(),
          after: client.track('smoke_event', { action: 'closed' }),
        }),
      );
      return;
    }
    setResult(JSON.stringify(await client.flush({ timeoutMs: 2000 })));
  }
  return (
    <main>
      <h1>Telemetry browser acceptance</h1>
      <p>This isolated application verifies SDK behavior against PostgreSQL.</p>
      <button disabled={!client} onClick={() => void action('track')}>
        Track identities
      </button>
      <button disabled={!client} onClick={() => void action('manual')}>
        Capture error
      </button>
      <button
        disabled={!client}
        onClick={() => {
          setTimeout(() => {
            throw new Error('Private window failure');
          }, 0);
        }}
      >
        Window error
      </button>
      <button
        disabled={!client}
        onClick={() => {
          void Promise.reject(new Error('Private rejected promise'));
        }}
      >
        Reject promise
      </button>
      <button disabled={!client} onClick={() => setBroken(true)}>
        Render error
      </button>
      <button disabled={!client} onClick={() => void action('flush')}>
        Flush
      </button>
      <button disabled={!client} onClick={() => void action('close')}>
        Close
      </button>
      <output data-testid="result">{result}</output>
      {client && (
        <TelemetryErrorBoundary client={client} fallback={<p>Rendering failure captured</p>}>
          {broken ? <Broken /> : <p>Boundary active</p>}
        </TelemetryErrorBoundary>
      )}
    </main>
  );
}

import { it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
it('the published tracing entry closes all tasks and lets a real Node process exit naturally', async () => {
  const module = pathToFileURL(resolve('dist/telemetry-sdk/tracing/server.js')).href;
  const source = `import {createTracer,injectTraceContext,extractTraceContext} from ${JSON.stringify(module)};
 const tracer=createTracer({endpoints:['http://127.0.0.1:4320'],environment:'test',service:'web',writeToken:'writer.'+'s'.repeat(32),sampleRate:1,transport:async()=>Response.json({})});
 const span=tracer.startSpan({name:'artifact'});const parent=extractTraceContext(injectTraceContext(span.context));if(parent.traceId!==span.context.traceId)throw new Error('Propagation failed');span.end();const result=await tracer.flush();await tracer.close();console.log(JSON.stringify({confirmed:result.confirmedSpans,...tracer.getDiagnostics()}));`;
  const result = await promisify(execFile)(
    process.execPath,
    ['--input-type=module', '-e', source],
    { timeout: 3000 },
  );
  expect(JSON.parse(result.stdout)).toMatchObject({
    confirmed: 1,
    closed: true,
    queuedSpans: 0,
    queuedBytes: 0,
    activeSpans: 0,
    recordingBytes: 0,
  });
});
it('regression: closed tracers must not retain AsyncLocalStorage instances after GC', async () => {
  const module = pathToFileURL(resolve('dist/telemetry-sdk/tracing/server.js')).href;
  const source = `
import { createTracer } from ${JSON.stringify(module)};
import { AsyncLocalStorage } from 'node:async_hooks';
import { queryObjects } from 'node:v8';
import { setImmediate } from 'node:timers/promises';
const before = queryObjects(AsyncLocalStorage, { format: 'count' });
async function cycle() {
  const tracer = createTracer({ endpoints: ['http://127.0.0.1:4320'], environment: 'test', service: 'web', writeToken: 'writer.' + 's'.repeat(32), sampleRate: 0, transport: async () => Response.json({}) });
  tracer.withSpan({ name: 'active' }, () => undefined);
  await tracer.close();
  await tracer.withSpan({ name: 'after-close' }, async (span) => {
    await Promise.resolve();
    if (tracer.currentContext() !== span.context) throw new Error('Closed callback lost context');
  });
  const failure = new Error('expected failure');
  try {
    tracer.withSpan({ name: 'sync-failure' }, () => { throw failure; });
  } catch (error) {
    if (error !== failure) throw error;
  }
  await tracer.withSpan({ name: 'async-failure' }, async () => {
    await Promise.resolve();
    throw failure;
  }).catch((error) => { if (error !== failure) throw error; });
}
for (let index = 0; index < 100; index++) await cycle();
await setImmediate();
console.log(JSON.stringify({ retained: queryObjects(AsyncLocalStorage, { format: 'count' }) - before }));
`;
  const result = await promisify(execFile)(
    process.execPath,
    ['--input-type=module', '-e', source],
    { timeout: 3000 },
  );
  expect(JSON.parse(result.stdout)).toEqual({ retained: 0 });
});

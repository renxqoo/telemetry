import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No TCP port allocated');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
export async function postgresBinaries(): Promise<string> {
  if (process.env.TELEMETRY_PG_BIN) return process.env.TELEMETRY_PG_BIN;
  for (const directory of ['/opt/homebrew/opt/postgresql@18/bin', '/usr/lib/postgresql/18/bin']) {
    try {
      await access(join(directory, 'initdb'));
      return directory;
    } catch {}
  }
  throw new Error('PostgreSQL 18 binaries required. Set TELEMETRY_PG_BIN to the bin directory.');
}
export async function startPostgres(): Promise<{
  url: string;
  directory: string;
  bin: string;
  stop: () => Promise<void>;
}> {
  const bin = await postgresBinaries();
  const directory = await mkdtemp(join(tmpdir(), 'oneaster-postgres-'));
  const data = join(directory, 'data');
  const port = await freePort();
  const run = (binary: string, args: string[]) => {
    const result = spawnSync(join(bin, binary), args, { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`${binary} failed: ${result.stderr || result.stdout}`);
  };
  let started = false;
  try {
    run('initdb', [
      '-D',
      data,
      '-U',
      'telemetry_test_admin',
      '--auth=trust',
      '--no-locale',
      '-E',
      'UTF8',
    ]);
    run('pg_ctl', [
      '-D',
      data,
      '-l',
      join(directory, 'postgres.log'),
      '-o',
      `-h 127.0.0.1 -p ${port} -k ${directory} -c max_connections=100`,
      '-w',
      'start',
    ]);
    started = true;
    return {
      url: `postgresql://telemetry_test_admin@127.0.0.1:${port}/postgres`,
      directory,
      bin,
      stop: async () => {
        run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (started) run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    let log = '';
    try {
      log = await readFile(join(directory, 'postgres.log'), 'utf8');
    } catch {}
    await rm(directory, { recursive: true, force: true });
    throw new Error(`${error instanceof Error ? error.message : 'Postgres setup failed'}\n${log}`);
  }
}

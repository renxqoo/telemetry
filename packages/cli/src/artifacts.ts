import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';

function artifactWorker(): void {
  const fs = process.getBuiltinModule('node:fs');
  const root = fs.fstatSync(3, { bigint: true });
  const current = fs.statSync('.', { bigint: true });
  if (root.dev !== current.dev || root.ino !== current.ino) process.exit(1);
  const directory = process.cwd();
  process.on('disconnect', () => process.exit());
  process.on('error', () => process.exit(1));
  process.on('message', (request: { path: string; limit: number }) => {
    try {
      const parts = request.path.split('/');
      if (
        !parts.length ||
        parts.some((part) => !part || part === '.' || part === '..' || /[\\\0]/.test(part)) ||
        !Number.isSafeInteger(request.limit) ||
        request.limit < 1 ||
        request.limit > 16 * 1024 * 1024
      )
        throw new Error('Invalid artifact request');
      process.chdir(directory);
      const base = fs.statSync('.', { bigint: true });
      if (root.dev !== base.dev || root.ino !== base.ino) throw new Error('Changed root');
      for (const part of parts.slice(0, -1)) {
        const handle = fs.openSync(
          part,
          fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
        );
        try {
          const expected = fs.fstatSync(handle, { bigint: true });
          process.chdir(part);
          const actual = fs.statSync('.', { bigint: true });
          if (expected.dev !== actual.dev || expected.ino !== actual.ino)
            throw new Error('Changed artifact directory');
        } finally {
          fs.closeSync(handle);
        }
      }
      const handle = fs.openSync(
        parts.at(-1)!,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      );
      try {
        const info = fs.fstatSync(handle);
        if (!info.isFile() || info.size > request.limit) throw new Error('Invalid artifact');
        const buffer = Buffer.alloc(info.size + 1);
        let bytes = 0;
        for (;;) {
          const count = fs.readSync(handle, buffer, bytes, buffer.length - bytes, null);
          if (!count) break;
          bytes += count;
          if (bytes > info.size || bytes > request.limit) throw new Error('Artifact grew');
        }
        const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes));
        process.send?.({ ok: true, content });
      } finally {
        fs.closeSync(handle);
      }
    } catch {
      process.send?.({ ok: false });
    }
  });
  process.send?.({ ok: true });
}

export async function withBuildArtifacts<T>(
  directory: string,
  use: (read: (path: string, limit: number) => Promise<string>) => Promise<T>,
): Promise<T> {
  if (
    !['linux', 'darwin'].includes(process.platform) ||
    constants.O_NOFOLLOW === undefined ||
    constants.O_DIRECTORY === undefined ||
    constants.O_NONBLOCK === undefined
  )
    throw new Error('Secure local build artifact reading is unsupported on this platform.');
  const path = resolve(directory);
  const root = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let worker: ReturnType<typeof spawn>;
  try {
    worker = spawn(
      process.execPath,
      ['--input-type=module', '--eval', `(${artifactWorker.toString()})();`],
      {
        cwd: path,
        stdio: ['ignore', 'ignore', 'ignore', root.fd, 'ipc'],
        env: { NODE_ENV: 'production' },
      },
    );
  } catch (error) {
    await root.close();
    throw error;
  }
  const closed = new Promise<void>((accept) => worker.once('close', () => accept()));
  const deadline = setTimeout(() => worker.kill('SIGKILL'), 10_000);
  const failure = 'Invalid build artifact or artifact escapes the specified directory.';
  function exchange(request?: { path: string; limit: number }): Promise<string> {
    return new Promise((accept, reject) => {
      function clear(): void {
        worker.off('message', message);
        worker.off('error', failed);
        worker.off('close', failed);
      }
      function failed(): void {
        clear();
        reject(new Error(failure));
      }
      function message(response: unknown): void {
        clear();
        const result = response as { ok: boolean; content?: string };
        if (!result?.ok || (request && typeof result.content !== 'string')) {
          reject(new Error(failure));
          return;
        }
        if (request && Buffer.byteLength(result.content!) > request.limit) {
          worker.kill('SIGKILL');
          reject(new Error(failure));
          return;
        }
        accept(result.content ?? '');
      }
      worker.once('message', message);
      worker.once('error', failed);
      worker.once('close', failed);
      if (worker.exitCode !== null || worker.signalCode !== null) failed();
      else if (request)
        worker.send(request, (error) => {
          if (error) failed();
        });
    });
  }
  try {
    await exchange();
    return await use((artifact, limit) => exchange({ path: artifact, limit }));
  } finally {
    clearTimeout(deadline);
    if (worker.exitCode === null && worker.signalCode === null) {
      worker.kill('SIGKILL');
    }
    await closed;
    await root.close();
  }
}

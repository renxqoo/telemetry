import { describe, it, expect } from 'vitest';
import { Client } from 'pg';
import { setTimeout as delay } from 'node:timers/promises';
import { startPostgres } from '../support/postgres.js';
describe('PostgreSQL 18 independent synchronous confirmation probe', () => {
  it('statement timeout does not bound SyncRep and cancelled COMMIT is locally committed with a warning', async () => {
    const postgres = await startPostgres();
    const control = new Client({ connectionString: postgres.url });
    const writer = new Client({ connectionString: postgres.url });
    try {
      await control.connect();
      await writer.connect();
      await control.query('CREATE TABLE commit_probe (id integer PRIMARY KEY)');
      await control.query(
        "ALTER SYSTEM SET synchronous_standby_names='FIRST 1 (missing_probe_replica)'",
      );
      await control.query('SELECT pg_reload_conf()');
      const configurationDeadline = performance.now() + 2000;
      let configured = false;
      while (performance.now() < configurationDeadline) {
        if (
          (await writer.query('SHOW synchronous_standby_names')).rows[0]
            .synchronous_standby_names === 'FIRST 1 (missing_probe_replica)'
        ) {
          configured = true;
          break;
        }
        await delay(10);
      }
      expect(configured).toBe(true);
      await writer.query(
        'SET synchronous_commit=on; SET statement_timeout=50; SET client_min_messages=warning',
      );
      const pidResult = await writer.query('SELECT pg_backend_pid() AS pid');
      const pid = Number(pidResult.rows[0].pid);
      const notices: unknown[] = [];
      writer.on('notice', (notice) => notices.push(notice));
      await writer.query('BEGIN');
      await writer.query('INSERT INTO commit_probe VALUES (1)');
      let finished = false;
      const commit = writer.query('COMMIT').then((result) => {
        finished = true;
        return result;
      });
      let syncRep = false;
      const started = performance.now();
      while (performance.now() - started < 2000) {
        const activity = await control.query(
          'SELECT wait_event FROM pg_stat_activity WHERE pid=$1',
          [pid],
        );
        if (activity.rows[0]?.wait_event === 'SyncRep') {
          syncRep = true;
          break;
        }
        await delay(10);
      }
      expect(syncRep).toBe(true);
      await delay(150);
      expect(finished).toBe(false);
      expect(
        (await control.query('SELECT pg_cancel_backend($1) AS cancelled', [pid])).rows[0].cancelled,
      ).toBe(true);
      expect((await commit).command).toBe('COMMIT');
      expect(notices.length).toBeGreaterThan(0);
      expect((await control.query('SELECT id FROM commit_probe')).rows).toEqual([{ id: 1 }]);
    } finally {
      await Promise.allSettled([writer.end(), control.end()]);
      await postgres.stop();
    }
  });
});

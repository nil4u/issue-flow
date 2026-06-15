import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { globSync } from 'node:fs';
import { openDashboardDb } from '../src/lib/db.ts';
import { ingestAgentrixBatch } from '../src/lib/agentrix/ingest.ts';
import { readAgentrixDataBin } from '../src/lib/agentrix/sqlite.ts';
import { getSyncState, shouldReplayForIssueLinking, updateSyncState } from '../src/lib/agentrix/sync-state.ts';

function expandHome(pathValue: string) {
  return pathValue.startsWith('~/') ? join(process.env.HOME ?? '', pathValue.slice(2)) : pathValue;
}

function hasFlag(flag: string) {
  return process.argv.includes(flag);
}

const dryRun = hasFlag('--dry-run');
const workspacesDir = expandHome(process.env.AGENTRIX_WORKSPACES_DIR ?? '~/.agentrix/workspaces');
const runnerId = process.env.AGENTRIX_RUNNER_ID ?? 'local-runner';
const ingestUrl = process.env.DASHBOARD_INGEST_URL;
const ingestToken = process.env.DASHBOARD_INGEST_TOKEN;

if (!existsSync(workspacesDir)) {
  console.log(`Agentrix workspaces dir not found: ${workspacesDir}`);
  process.exit(0);
}

const dataBins = globSync('users/*/{task-*,chat-*}/data/data.bin', { cwd: workspacesDir }).map((relativePath) =>
  join(workspacesDir, relativePath)
);

if (dryRun) {
  console.log(JSON.stringify({ dryRun: true, runnerId, dataBins }, null, 2));
  process.exit(0);
}

const db = openDashboardDb();
try {
  for (const dbPath of dataBins) {
    const syncState = getSyncState(db, runnerId, dbPath);
    const afterSequence = shouldReplayForIssueLinking(db, syncState) ? undefined : (syncState?.last_sequence ?? undefined);
    const batch = readAgentrixDataBin({
      dbPath,
      sourcePath: dbPath,
      runnerId,
      afterSequence
    });
    if (batch.events.length === 0) {
      continue;
    }

    if (ingestUrl) {
      const response = await fetch(ingestUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(ingestToken ? { authorization: `Bearer ${ingestToken}` } : {})
        },
        body: JSON.stringify(batch)
      });
      if (!response.ok) {
        throw new Error(`Agentrix ingest failed ${response.status}: ${await response.text()}`);
      }
    } else {
      ingestAgentrixBatch(db, batch);
    }

    const lastEvent = batch.events.at(-1);
    updateSyncState(db, {
      runnerId,
      sourcePath: dbPath,
      taskId: batch.taskId,
      lastSequence: lastEvent?.sequence ?? null,
      lastEventId: lastEvent?.sourceEventId ?? null,
      lastMtime: statSync(dbPath).mtimeMs
    });
    console.log(`synced ${batch.events.length} events from ${dbPath}`);
  }
} finally {
  db.close();
}

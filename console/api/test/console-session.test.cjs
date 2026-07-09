const assert = require('node:assert/strict');
const test = require('node:test');

require('tsx/cjs');

// store.ts -> storage/db.ts 需要 DATABASE_URL 才能加载;
// 本文件全部走 fake db,不会真正连接。
process.env.DATABASE_URL ||= 'postgresql://issue-flow:test@127.0.0.1:5432/issue_flow_test';

const {
  CONSOLE_SESSION_TTL_MS,
  TOUCH_INTERVAL_MS,
  hashConsoleSessionToken,
  newConsoleSessionToken,
} = require('../src/core/console-session.ts');
const { IssueFlowStore } = require('../src/core/store.ts');

function fakeDb() {
  const rows = new Map();
  const calls = [];
  return {
    calls,
    rows,
    consoleSession: {
      async create({ data }) {
        calls.push(['create', data]);
        rows.set(data.tokenHash, { ...data });
        return { ...data };
      },
      async findUnique({ where }) {
        calls.push(['findUnique', where]);
        const row = rows.get(where.tokenHash);
        return row ? { ...row } : null;
      },
      async update({ where, data }) {
        calls.push(['update', where, data]);
        const row = [...rows.values()].find((item) => item.id === where.id);
        Object.assign(row, data);
        return { ...row };
      },
      async deleteMany({ where }) {
        calls.push(['deleteMany', where]);
        for (const [key, row] of rows) {
          if (where.id && row.id !== where.id) continue;
          if (where.userId && row.userId !== where.userId) continue;
          rows.delete(key);
        }
        return { count: 1 };
      },
    },
  };
}

function storeWith(db) {
  return new IssueFlowStore({ db, key: 'console-session-test-key' });
}

test('token generation is high-entropy base64url and hashing is stable', () => {
  const token = newConsoleSessionToken();
  assert.equal(token.length, 43, '32 bytes base64url = 43 chars');
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(newConsoleSessionToken(), token);
  const hash = hashConsoleSessionToken(token);
  assert.equal(hash, hashConsoleSessionToken(token));
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.notEqual(hash, token);
});

test('createConsoleSession stores only the token hash and returns the token once', async () => {
  const db = fakeDb();
  const store = storeWith(db);
  const { token, session } = await store.createConsoleSession({ userId: 'user_1', userAgent: 'ua', ip: '::1' });
  assert.ok(token);
  assert.ok(session.id.startsWith('csess_'));
  assert.equal(session.userId, 'user_1');
  const [, created] = db.calls.find(([kind]) => kind === 'create');
  assert.equal(created.tokenHash, hashConsoleSessionToken(token));
  assert.ok(!JSON.stringify(created).includes(token), 'raw token never reaches the database');
  assert.deepEqual(created.data, { userAgent: 'ua', ip: '::1' });
  const ttl = created.expiresAt.getTime() - created.lastSeenAt.getTime();
  assert.equal(ttl, CONSOLE_SESSION_TTL_MS);
});

test('getConsoleSessionByToken resolves fresh sessions without touching the row', async () => {
  const db = fakeDb();
  const store = storeWith(db);
  const { token, session } = await store.createConsoleSession({ userId: 'user_1' });
  const found = await store.getConsoleSessionByToken(token);
  assert.equal(found.id, session.id);
  assert.equal(found.userId, 'user_1');
  assert.ok(!db.calls.some(([kind]) => kind === 'update'), 'recent lastSeen must not trigger a write');
  assert.equal(await store.getConsoleSessionByToken('missing-token'), undefined);
  assert.equal(await store.getConsoleSessionByToken(''), undefined);
});

test('getConsoleSessionByToken rejects expired sessions', async () => {
  const db = fakeDb();
  const store = storeWith(db);
  const { token } = await store.createConsoleSession({ userId: 'user_1' });
  const row = [...db.rows.values()][0];
  row.expiresAt = new Date(Date.now() - 1000);
  assert.equal(await store.getConsoleSessionByToken(token), undefined);
});

test('getConsoleSessionByToken slides expiry when lastSeen is stale', async () => {
  const db = fakeDb();
  const store = storeWith(db);
  const { token } = await store.createConsoleSession({ userId: 'user_1' });
  const row = [...db.rows.values()][0];
  row.lastSeenAt = new Date(Date.now() - TOUCH_INTERVAL_MS - 60 * 1000);
  const before = Date.now();
  const found = await store.getConsoleSessionByToken(token);
  const [, , updated] = db.calls.find(([kind]) => kind === 'update');
  assert.ok(updated.lastSeenAt.getTime() >= before, 'lastSeen refreshed');
  assert.ok(updated.expiresAt.getTime() >= before + CONSOLE_SESSION_TTL_MS - 1000, 'expiry slides forward');
  assert.equal(Date.parse(found.expiresAt), updated.expiresAt.getTime(), 'returned session reflects the touch');
});

test('deleteConsoleSession removes a single session and keeps siblings', async () => {
  const db = fakeDb();
  const store = storeWith(db);
  const first = await store.createConsoleSession({ userId: 'user_1' });
  const second = await store.createConsoleSession({ userId: 'user_1' });
  await store.deleteConsoleSession(first.session.id);
  assert.equal(await store.getConsoleSessionByToken(first.token), undefined);
  assert.ok(await store.getConsoleSessionByToken(second.token), 'other sessions survive');
  await store.deleteConsoleSessionsForUser('user_1');
  assert.equal(await store.getConsoleSessionByToken(second.token), undefined);
});

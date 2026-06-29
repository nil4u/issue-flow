#!/usr/bin/env node

const { spawn } = require('node:child_process');

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const apiUrl = process.env.VITE_ISSUE_FLOW_API_BASE_URL || 'http://127.0.0.1:8788';
const webOrigin = process.env.ISSUE_FLOW_WEB_ORIGIN || 'http://127.0.0.1:8787';
const databaseUrl = process.env.DATABASE_URL || 'postgres://issue_flow:issue_flow@127.0.0.1:5432/issue_flow';

const children = [];
let shuttingDown = false;

function start(name, command, args, env) {
  const child = spawn(command, args, {
    env: {
      ...process.env,
      ...env,
    },
    stdio: 'inherit',
  });
  children.push(child);
  child.on('exit', (code, signal) => {
    if (!shuttingDown && code !== 0) {
      console.error(`[issue-flow-dev] ${name} exited with ${signal || code}`);
      shutdown(code || 1);
    }
  });
}

function shutdown(code = 0) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }
  setTimeout(() => process.exit(code), 250);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

start('api', npm, ['run', 'api:dev'], {
  DATABASE_URL: databaseUrl,
  ISSUE_FLOW_WEB_ORIGIN: webOrigin,
});

start('web', npm, [
  '--workspace',
  'issue-flow-web',
  'run',
  'dev',
  '--',
  '--host',
  '127.0.0.1',
  '--port',
  '8787',
], {
  VITE_ISSUE_FLOW_API_BASE_URL: apiUrl,
});

#!/usr/bin/env node

const { spawn } = require('node:child_process');

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const mode = process.argv[2] || 'dev';
const viteArgs = mode === 'build'
  ? ['--workspace', 'issue-flow-web', 'run', 'build']
  : [
      '--workspace',
      'issue-flow-web',
      'run',
      mode,
      '--',
      '--host',
      process.env.ISSUE_FLOW_WEB_HOST || '127.0.0.1',
      '--port',
      process.env.ISSUE_FLOW_WEB_PORT || '8787',
    ];

const child = spawn(npm, viteArgs, {
  env: {
    ...process.env,
    ISSUE_FLOW_BASE_URL: process.env.ISSUE_FLOW_BASE_URL || 'http://127.0.0.1:8788',
  },
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code || 0;
});

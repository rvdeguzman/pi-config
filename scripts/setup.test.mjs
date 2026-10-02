import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-config-setup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of ['Makefile', 'settings.example.json']) {
    copyFileSync(join(root, name), join(dir, name));
  }
  return dir;
}

function make(dir, target, env = {}) {
  return execFileSync('make', [target], {
    cwd: dir,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

test('restores portable settings without changing auth', (t) => {
  const dir = fixture(t);
  writeFileSync(join(dir, 'auth.json'), 'local credentials');
  writeFileSync(join(dir, 'mcp-auth.json'), 'local MCP credentials');
  make(dir, 'restore-settings');
  const settings = readFileSync(join(dir, 'settings.json'), 'utf8');
  assert.equal(settings, readFileSync(join(dir, 'settings.example.json'), 'utf8'));
  const parsed = JSON.parse(settings);
  assert.ok(parsed.packages.length > 0);
  assert.equal('deviceId' in parsed, false);
  assert.equal('lastChangelogVersion' in parsed, false);
  assert.equal(readFileSync(join(dir, 'auth.json'), 'utf8'), 'local credentials');
  assert.equal(readFileSync(join(dir, 'mcp-auth.json'), 'utf8'), 'local MCP credentials');
});

test('repeated setup keeps existing settings byte-for-byte', (t) => {
  const dir = fixture(t);
  const local = '{"theme":"light","packages":[]}\n';
  writeFileSync(join(dir, 'settings.json'), local);
  make(dir, 'restore-settings');
  make(dir, 'restore-settings');
  assert.equal(readFileSync(join(dir, 'settings.json'), 'utf8'), local);
});

test('does not overwrite a dangling settings symlink', (t) => {
  const dir = fixture(t);
  symlinkSync('missing.json', join(dir, 'settings.json'));
  assert.match(make(dir, 'restore-settings'), /Keeping existing settings.json/);
});

test('setup restores settings before reconciling packages in this checkout', (t) => {
  const dir = fixture(t);
  writeFileSync(join(dir, 'pi'), '#!/bin/sh\nset -eu\ntest -f "$PI_CODING_AGENT_DIR/settings.json"\nprintf "%s\\n" "$PI_CODING_AGENT_DIR" "$@" > invocation.txt\n', { mode: 0o755 });
  make(dir, 'setup', {
    PATH: `${dir}:${process.env.PATH}`,
    PI_CODING_AGENT_DIR: '/not-this-checkout',
  });
  assert.equal(readFileSync(join(dir, 'invocation.txt'), 'utf8'), `${realpathSync(dir)}\nupdate\n--extensions\n--no-approve\n`);
});

test('portable files are allowed while settings and credentials remain ignored', () => {
  for (const name of ['settings.json', 'auth.json', 'mcp-auth.json', 'npm/', 'git/']) {
    assert.equal(execFileSync('git', ['check-ignore', '--no-index', name], { cwd: root, encoding: 'utf8' }).trim(), name);
  }
  for (const name of ['settings.example.json', 'Makefile', 'README.md']) {
    assert.throws(() => execFileSync('git', ['check-ignore', '--no-index', name], { cwd: root }), { status: 1 });
  }
});

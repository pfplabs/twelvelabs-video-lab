import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FixtureInventoryProvider } from './providers.ts';
import { inventoryResponse } from './api.ts';
import { renderInventory, makeServer } from './server.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const cases = JSON.parse(readFileSync(new URL('../fixtures/inventory-cases.json', import.meta.url), 'utf8'));
const fixture = new URL('../fixtures/inventory.json', import.meta.url);

test('shared acceptance cases and complete Python/Node response parity', () => {
  const directory = mkdtempSync(join(tmpdir(), 'video-lab-'));
  try {
    const path = join(directory, 'inventory.json');
    const results = cases.map(item => {
      writeFileSync(path, JSON.stringify(item.rows));
      const result = inventoryResponse(new FixtureInventoryProvider(path));
      assert.equal(result.status, item.status, item.name);
      if (item.status === 200) {
        assert.equal(result.payload.eligible_count, item.eligible_count, item.name);
        assert.equal(result.payload.videos.length, item.rows.length, item.name);
      } else assert.equal(result.payload.error, 'inventory_unavailable');
      return result;
    });
    const python = JSON.parse(execFileSync('python3', ['-m', 'tests.contract_probe'], { cwd: root, encoding: 'utf8', timeout: 10000 }));
    assert.deepEqual(results, python);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('all items remain visible, failure has no invented reason', () => {
  const result = renderInventory(new FixtureInventoryProvider(fixture));
  assert.equal(result.status, 200);
  assert.match(result.html, /3 items · 2 eligible/);
  for (const name of ['synthetic-mountains.mp4', 'synthetic-dragon.mp4', 'synthetic-failed.mp4']) assert.ok(result.html.includes(name));
  assert.ok(result.html.includes('<td>failed</td><td>Failure reason unavailable.</td><td>Not eligible</td>'));
});

test('missing fixture and malformed JSON remain visible errors', () => {
  const directory = mkdtempSync(join(tmpdir(), 'video-lab-'));
  try {
    const path = join(directory, 'missing.json');
    const provider = new FixtureInventoryProvider(path);
    for (const contents of [null, 'not json']) {
      if (contents !== null) writeFileSync(path, contents);
      const result = renderInventory(provider);
      assert.equal(result.status, 503);
      assert.match(result.html, /role="alert"/);
      assert.ok(!result.html.includes('No videos in inventory'));
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('rendering escapes metadata and reads provider once without mutations', () => {
  const videos = new FixtureInventoryProvider(fixture).listVideos();
  videos[2].filename = '<script>.mp4';
  videos[2].failure_reason = '<unsafe>';
  const before = structuredClone(videos);
  let calls = 0;
  const result = renderInventory({ listVideos() { calls++; return videos; } });
  assert.equal(calls, 1);
  assert.deepEqual(videos, before);
  assert.ok(result.html.includes('&lt;script&gt;.mp4'));
  assert.ok(result.html.includes('&lt;unsafe&gt;'));
  assert.ok(!result.html.includes('<unsafe>'));
});

test('HTTP routing without opening a socket', () => {
  const server = makeServer(new FixtureInventoryProvider(fixture));
  for (const [url, method, expected] of [
    ['/api/inventory', 'GET', 200], ['/', 'GET', 200],
    ['/missing', 'GET', 404], ['/api/inventory', 'POST', 405],
  ] as const) {
    let status = 0;
    let headers = {};
    let body = '';
    server.emit('request', { url, method }, {
      writeHead(code, values = {}) { status = code; headers = values; },
      end(value = '') { body = value; },
    });
    assert.equal(status, expected);
    if (url === '/api/inventory' && method === 'GET') {
      assert.equal(JSON.parse(body).eligible_count, 2);
      assert.equal(headers['Content-Type'], 'application/json; charset=utf-8');
      assert.equal(headers['Cache-Control'], 'no-store');
    }
    if (url === '/') assert.match(body, /3 items · 2 eligible/);
  }
});

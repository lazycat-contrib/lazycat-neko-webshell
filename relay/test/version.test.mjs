import {test} from 'node:test';
import assert from 'node:assert/strict';
import metadata from '../package.json' with {type: 'json'};
import worker from '../src/worker.mjs';

test('root GET reports only package, protocol and supplied build metadata without caching', async () => {
  const response = await worker.fetch(new Request('https://relay.example/'), {
    RELAY_BUILD_COMMIT: 'abc123', RELAY_BUILD_TIME: '2026-11-12T00:00:00Z',
    REGISTRATION_KEY: 'must-never-appear',
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-type'), /^application\/json/);
  assert.deepEqual(await response.json(), {
    service: metadata.name, package_version: metadata.version,
    relay_protocol: 'neko.remoted.v1', protocol_version: 1,
    build_commit: 'abc123', build_time: '2026-11-12T00:00:00Z',
  });
});

test('missing or blank build metadata is unknown and root rejects queries and non-GET methods', async () => {
  for (const env of [{}, {RELAY_BUILD_COMMIT: '', RELAY_BUILD_TIME: ' '}]) {
    const response = await worker.fetch(new Request('https://relay.example/'), env);
    const body = await response.json();
    assert.equal(body.build_commit, 'unknown');
    assert.equal(body.build_time, 'unknown');
  }
  assert.equal((await worker.fetch(new Request('https://relay.example/?route=secret'), {})).status, 404);
  assert.equal((await worker.fetch(new Request('https://relay.example/', {method: 'POST'}), {})).status, 405);
});

test('health remains the current v1 protocol check', async () => {
  const env = new Proxy({}, {get() { throw Error('unexpected business object access'); }});
  const response = await worker.fetch(new Request('https://relay.example/healthz'), env);
  assert.deepEqual(await response.json(), {protocol: 'neko.remoted.v1', version: 1});
});

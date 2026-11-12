import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import WebSocket from 'ws';
import metadata from '../package.json' with {type: 'json'};

const origin = process.env.REMOTED_TEST_RELAY || 'http://127.0.0.1:18791';
const wsOrigin = origin.replace(/^http/, 'ws');
const protocol = 'neko.remoted.v2';

function credentials() {
  const key = randomBytes(32);
  return {key: key.toString('base64url'), route: createHash('sha256').update(key).digest('base64url')};
}

async function open(role, credentials, key = credentials.key) {
  const ws = new WebSocket(`${wsOrigin}/v2/${role}/${credentials.route}`, protocol, {
    handshakeTimeout: 4000,
    headers: role === 'host' ? {authorization: `Bearer ${key}`} : {},
  });
  const frames = [];
  const listeners = [];
  ws.on('message', data => {
    const frame = JSON.parse(data);
    const listener = listeners.find(current => current.type === frame.type);
    if (listener) {
      listeners.splice(listeners.indexOf(listener), 1);
      clearTimeout(listener.timer);
      listener.resolve(frame);
    } else frames.push(frame);
  });
  const closed = new Promise(resolve => ws.once('close', resolve));
  const take = type => {
    const index = frames.findIndex(frame => frame.type === type);
    if (index >= 0) return Promise.resolve(frames.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const listener = {type, resolve, timer: setTimeout(() => {
        listeners.splice(listeners.indexOf(listener), 1);
        reject(Error(`timed out waiting for ${type}`));
      }, 4000)};
      listeners.push(listener);
    });
  };
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
    ws.once('unexpected-response', (_, response) => {
      response.resume();
      ws.terminate();
      reject(Error(`HTTP ${response.statusCode}`));
    });
  });
  return {ws, frames, take, closed, send: frame => ws.send(JSON.stringify(frame)), close: () => ws.close()};
}

async function setup(context) {
  const credentialsForRoute = credentials();
  const host = await open('host', credentialsForRoute);
  const sockets = [host];
  context.after(() => { for (const socket of sockets) socket.close(); });
  await host.take('connected');
  const client = async () => {
    const connection = await open('client', credentialsForRoute);
    sockets.push(connection);
    const {peer} = await connection.take('connected');
    assert.equal((await host.take('opened')).peer, peer);
    connection.send({type: 'hello', mode: 'connect'});
    assert.equal((await host.take('hello')).peer, peer);
    return {...connection, peer};
  };
  return {host, client, credentials: credentialsForRoute, sockets};
}

async function ping(host, nonce) {
  host.send({type: 'ping', nonce});
  assert.equal((await host.take('pong')).nonce, nonce);
}

test('real DO multiplexes v2 peers, rejects hijack and fences replacement generations', {timeout: 20000}, async context => {
  const fixture = await setup(context);
  const {host} = fixture;
  const first = await fixture.client();
  const second = await fixture.client();
  assert.notEqual(first.peer, second.peer);
  first.send({type: 'data', peer: second.peer, data: 'YWJj'});
  const inbound = await host.take('data');
  assert.equal(inbound.peer, first.peer);
  host.send({type: 'acknowledge', peer: 'host', sequence: inbound.sequence});
  assert.equal((await first.take('delivered')).count, 1);
  host.send({type: 'data', peer: first.peer, data: 'ZGVm'});
  const outbound = await first.take('data');
  assert.equal(outbound.data, 'ZGVm');
  first.send({type: 'acknowledge', peer: first.peer, sequence: outbound.sequence});
  assert.equal((await host.take('delivered')).peer, first.peer);
  await assert.rejects(open('host', fixture.credentials, randomBytes(32).toString('base64url')), /401/);
  await ping(host, 'survived-hijack');
  const replacement = await open('host', fixture.credentials);
  fixture.sockets.push(replacement);
  await replacement.take('connected');
  assert.equal(await host.closed, 4000);
  assert.equal(await first.closed, 1012);
  assert.equal(await second.closed, 1012);
  await ping(replacement, 'new-generation');
});

test('exact ACK 9 and then 3 cannot release another peer tokens 1 through 8', {timeout: 15000}, async context => {
  const {host, client} = await setup(context);
  const slow = await client();
  const fast = await client();
  for (let index = 0; index < 8; index++) slow.send({type: 'data', data: 'AA'});
  for (let sequence = 1; sequence <= 8; sequence++) assert.equal((await host.take('data')).sequence, sequence);
  fast.send({type: 'data', data: 'AA'});
  assert.equal((await host.take('data')).sequence, 9);
  host.send({type: 'acknowledge', peer: 'host', sequence: 9});
  assert.deepEqual(await fast.take('delivered'), {type: 'delivered', peer: fast.peer, count: 1});
  await ping(host, 'acked-nine');
  assert.equal(slow.frames.filter(frame => frame.type === 'delivered').length, 0);
  host.send({type: 'acknowledge', peer: 'host', sequence: 3});
  assert.equal((await slow.take('delivered')).count, 1);
  slow.send({type: 'data', data: 'AA'});
  assert.equal((await host.take('data')).sequence, 10);
  slow.send({type: 'data', data: 'AA'});
  assert.equal(await slow.closed, 1008);
  assert.equal((await host.take('closed')).peer, slow.peer);
  await ping(host, 'slow-isolated');
});

test('closing a slow peer frees the host window for sixteen peers with eight tokens each', {timeout: 20000}, async context => {
  const {host, client} = await setup(context);
  const slow = await client();
  for (let index = 0; index < 8; index++) slow.send({type: 'data', data: 'AA'});
  for (let index = 0; index < 8; index++) await host.take('data');
  slow.close();
  assert.equal((await host.take('closed')).peer, slow.peer);
  for (let index = 0; index < 16; index++) {
    const current = await client();
    for (let frame = 0; frame < 8; frame++) current.send({type: 'data', data: 'AA'});
    for (let frame = 0; frame < 8; frame++) assert.equal((await host.take('data')).peer, current.peer);
    assert.equal(current.ws.readyState, WebSocket.OPEN);
  }
  await ping(host, 'full-window-still-live');
});

test('out-of-order downstream credits recover and a slow client never kills the host', {timeout: 20000}, async context => {
  const {host, client} = await setup(context);
  const slow = await client();
  for (let index = 0; index < 8; index++) host.send({type: 'data', peer: slow.peer, data: 'AA'});
  const tokens = [];
  for (let index = 0; index < 8; index++) tokens.push((await slow.take('data')).sequence);
  for (const sequence of tokens.reverse()) slow.send({type: 'acknowledge', peer: slow.peer, sequence});
  for (let index = 0; index < 8; index++) assert.deepEqual(await host.take('delivered'), {type: 'delivered', peer: slow.peer, count: 1});
  for (let index = 0; index < 9; index++) host.send({type: 'data', peer: slow.peer, data: 'AA'});
  assert.equal(await slow.closed, 1008);
  assert.equal((await host.take('closed')).peer, slow.peer);
  await ping(host, 'survived-slow-client');
  const fast = await client();
  host.send({type: 'data', peer: fast.peer, data: 'ZGVm'});
  assert.equal((await fast.take('data')).data, 'ZGVm');
});

test('duplicate ACK is a no-op while wrong peer ACK rejects only its client sender', {timeout: 15000}, async context => {
  const {host, client} = await setup(context);
  const duplicate = await client();
  host.send({type: 'data', peer: duplicate.peer, data: 'AA'});
  const {sequence} = await duplicate.take('data');
  duplicate.send({type: 'acknowledge', peer: duplicate.peer, sequence});
  await host.take('delivered');
  duplicate.send({type: 'acknowledge', peer: duplicate.peer, sequence});
  await ping(duplicate, 'duplicate-ack-survived');
  await ping(host, 'no-duplicate-credit');
  assert.equal(host.frames.some(frame => frame.type === 'delivered'), false);
  const wrongPeer = await client();
  host.send({type: 'data', peer: wrongPeer.peer, data: 'AA'});
  const pending = await wrongPeer.take('data');
  wrongPeer.send({type: 'acknowledge', peer: 'host', sequence: pending.sequence});
  assert.equal(await wrongPeer.closed, 1008);
  await host.take('closed');
  await ping(host, 'survived-invalid-acks');
});

test('late ACKs after A closes preserve host and B credit, then B continues', {timeout: 15000}, async context => {
  const {host, client} = await setup(context);
  const a = await client();
  for (let index = 0; index < 8; index++) a.send({type: 'data', data: 'AA'});
  const retired = [];
  for (let index = 0; index < 8; index++) retired.push((await host.take('data')).sequence);
  a.close();
  assert.equal((await host.take('closed')).peer, a.peer);
  const b = await client();
  for (let index = 0; index < 8; index++) b.send({type: 'data', data: 'AA'});
  const pending = [];
  for (let index = 0; index < 8; index++) pending.push((await host.take('data')).sequence);
  for (const sequence of retired) host.send({type: 'acknowledge', peer: 'host', sequence});
  await ping(host, 'late-acks-survived');
  await ping(b, 'no-retired-credit');
  assert.equal(b.frames.some(frame => frame.type === 'delivered'), false);
  host.send({type: 'acknowledge', peer: 'host', sequence: pending[0]});
  host.send({type: 'acknowledge', peer: 'host', sequence: pending[0]});
  assert.deepEqual(await b.take('delivered'), {type: 'delivered', peer: b.peer, count: 1});
  await ping(host, 'duplicate-host-ack-survived');
  await ping(b, 'exactly-one-credit');
  assert.equal(b.frames.some(frame => frame.type === 'delivered'), false);
  b.send({type: 'data', data: 'ZGVm'});
  assert.equal((await host.take('data')).data, 'ZGVm');
});

test('future ACK is rejected and an offline route reports failure', {timeout: 10000}, async context => {
  const {host, client} = await setup(context);
  const current = await client();
  current.send({type: 'acknowledge', peer: current.peer, sequence: 1});
  assert.equal(await current.closed, 1008);
  await host.take('closed');
  await ping(host, 'healthy');
  await assert.rejects(open('client', credentials()), /503/);
});

test('real root version diagnostic and health expose only v2 with no-store JSON', {timeout: 10000}, async () => {
  const response = await fetch(`${origin}/`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-type'), /^application\/json/);
  assert.deepEqual(await response.json(), {
    service: metadata.name, package_version: metadata.version,
    relay_protocol: protocol, protocol_version: 2,
    build_commit: 'unknown', build_time: 'unknown',
  });
  assert.equal((await fetch(`${origin}/?route=private`)).status, 404);
  assert.equal((await fetch(`${origin}/`, {method: 'POST'})).status, 405);
  assert.equal((await fetch(`${origin}/v1/client/${credentials().route}`)).status, 404);
  const health = await fetch(`${origin}/healthz`);
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await health.json(), {protocol, version: 2});
});

test('health WebSocket returns v2 then closes after a single response', {timeout: 10000}, async () => {
  const socket = new WebSocket(`${wsOrigin}/healthz`, protocol, {handshakeTimeout: 4000});
  const frames = [];
  try {
    const code = await new Promise((resolve, reject) => {
      socket.on('message', data => frames.push(JSON.parse(data)));
      socket.once('close', resolve);
      socket.once('error', reject);
      socket.once('unexpected-response', (_, response) => {
        response.resume(); socket.terminate(); reject(Error(`HTTP ${response.statusCode}`));
      });
    });
    assert.equal(code, 1000);
    assert.equal(socket.protocol, protocol);
    assert.deepEqual(frames, [{protocol, version: 2}]);
  } finally { socket.close(); }
});

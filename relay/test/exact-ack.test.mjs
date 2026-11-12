import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tunnel, LIMITS } from '../src/worker.mjs';

function fixture() {
  const tunnel = new Tunnel({blockConcurrencyWhile() {}, storage: {}}, {});
  tunnel.generation = 1;
  const record = (role, peer) => {
    const messages = [];
    const closes = [];
    return {
      role, peer, generation: 1, second: 0, frames: 0, hello: true,
      sent: 0, inflight: 0, pending: new Map(), messages, closes,
      socket: {send(data) { messages.push(JSON.parse(data)); }, close(code) { closes.push(code); }},
    };
  };
  const host = record('host', null);
  tunnel.host = host;
  const client = peer => {
    const connection = record('client', peer);
    tunnel.peers.set(peer, connection);
    return connection;
  };
  const send = (connection, frame) => tunnel.message(connection.role, connection, JSON.stringify(frame));
  const data = connection => send(connection, {type: 'data', data: 'AA'});
  const ack = (connection, sequence, peer = connection.role === 'host' ? 'host' : connection.peer) =>
    send(connection, {type: 'acknowledge', peer, sequence});
  return {tunnel, host, client, send, data, ack};
}

test('ACK 9 releases only fast peer credit while slow tokens 1 through 8 remain pending', () => {
  const {tunnel, host, client, data, ack} = fixture();
  const slow = client('slow');
  const fast = client('fast');
  for (let index = 0; index < 8; index++) data(slow);
  data(fast);
  ack(host, 9);
  assert.deepEqual([...host.pending.keys()], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(slow.inflight, 8);
  assert.equal(fast.inflight, 0);
  assert.deepEqual(fast.messages, [{type: 'delivered', peer: 'fast', count: 1}]);
  assert.deepEqual(slow.messages, []);
  data(fast);
  ack(host, 10);
  ack(host, 3);
  assert.equal(slow.inflight, 7);
  assert.equal(tunnel.host, host);
});

test('closing a slow origin removes its host tokens and allows all remaining peers their own windows', () => {
  const {tunnel, host, client, data} = fixture();
  const slow = client('slow');
  for (let index = 0; index < 8; index++) data(slow);
  tunnel.closed('client', slow);
  assert.equal(host.pending.size, 0);
  assert.equal(slow.inflight, 0);
  for (let peer = 0; peer < LIMITS.peers; peer++) {
    const current = client(`peer-${peer}`);
    for (let index = 0; index < 8; index++) data(current);
    assert.equal(tunnel.peers.get(current.peer), current);
  }
  assert.equal(host.pending.size, LIMITS.peers * 8);
  assert.equal(tunnel.host, host);
});

test('host window counts pending tokens rather than the largest acknowledged sequence', () => {
  const {host, client, data, ack} = fixture();
  host.sent = 1000;
  const current = client('peer');
  for (let index = 0; index < 100; index++) {
    data(current);
    ack(host, index + 1001);
    assert.equal(host.pending.size, 0);
    assert.equal(current.inflight, 0);
  }
  assert.equal(host.sent, 1100);
});

test('future, missing, mismatched and malformed ACKs close only a client sender', () => {
  for (const frame of [
    {type: 'acknowledge', peer: 'peer', sequence: 2},
    {type: 'acknowledge', sequence: 1},
    {type: 'acknowledge', peer: 'other', sequence: 1},
    {type: 'acknowledge', peer: 'peer', sequence: 0},
    {type: 'acknowledge', peer: 'peer', sequence: 1.5},
    {type: 'acknowledge', peer: 'peer', sequence: Number.MAX_SAFE_INTEGER + 1},
    {type: 'acknowledge', peer: 'peer', sequence: 1, extra: true},
  ]) {
    const {tunnel, host, client, send} = fixture();
    const current = client('peer');
    send(host, {type: 'data', peer: current.peer, data: 'AA'});
    send(current, frame);
    assert.equal(tunnel.host, host);
    assert.equal(tunnel.peers.has('peer'), false, JSON.stringify(frame));
    assert.deepEqual(current.closes, [1008]);
    assert.equal(host.messages.filter(message => message.type === 'delivered').length, 0);
  }
});

test('host ACK peer must be host even for a known pending token', () => {
  const {tunnel, host, client, data, ack} = fixture();
  const current = client('peer');
  data(current);
  ack(host, 1, 'peer');
  assert.equal(tunnel.host, null);
  assert.deepEqual(current.messages, []);
  assert.equal(host.pending.size, 0);
});

test('duplicate host ACK is a no-op and cannot return the same credit twice', () => {
  const {tunnel, host, client, data, ack} = fixture();
  const current = client('peer');
  data(current);
  ack(host, 1);
  ack(host, 1);
  assert.deepEqual(current.messages, [{type: 'delivered', peer: 'peer', count: 1}]);
  assert.equal(tunnel.host, host);
  assert.deepEqual(host.closes, []);
  assert.equal(host.pending.size, 0);
});

test('duplicate client ACK is a no-op without releasing another pending token', () => {
  const {tunnel, host, client, send, ack} = fixture();
  const current = client('peer');
  for (let index = 0; index < 2; index++) send(host, {type: 'data', peer: current.peer, data: 'AA'});
  ack(current, 1);
  ack(current, 1);
  assert.equal(tunnel.peers.get('peer'), current);
  assert.deepEqual(current.closes, []);
  assert.deepEqual([...current.pending.keys()], [2]);
  assert.deepEqual(host.messages, [{type: 'delivered', peer: 'peer', count: 1}]);
});

test('late ACKs for eight retired A tokens keep host live without releasing B credit', () => {
  const {tunnel, host, client, data, ack} = fixture();
  const a = client('A');
  for (let index = 0; index < 8; index++) data(a);
  tunnel.closed('client', a);
  const b = client('B');
  for (let index = 0; index < 8; index++) data(b);
  for (let sequence = 1; sequence <= 8; sequence++) ack(host, sequence);
  assert.equal(tunnel.host, host);
  assert.deepEqual(host.closes, []);
  assert.deepEqual([...host.pending.keys()], [9, 10, 11, 12, 13, 14, 15, 16]);
  assert.equal(b.inflight, 8);
  assert.deepEqual(b.messages, []);
  assert.deepEqual(a.messages, []);
  ack(host, 9);
  ack(host, 9);
  assert.equal(b.inflight, 7);
  assert.deepEqual(b.messages, [{type: 'delivered', peer: 'B', count: 1}]);
  data(b);
  assert.equal(b.inflight, 8);
  assert.equal(host.pending.size, 8);
});

test('future host ACK is rejected even after an earlier token retired', () => {
  const {tunnel, host, client, data, ack} = fixture();
  const a = client('A');
  data(a);
  tunnel.closed('client', a);
  ack(host, 2);
  assert.equal(tunnel.host, null);
  assert.deepEqual(host.closes, [1008]);
});

test('the host retains the existing aggregate 256 frame budget for 128 data and 128 exact ACKs', context => {
  context.mock.method(Date, 'now', () => 1_700_000_000_000);
  const {tunnel, host, client, data, send, ack} = fixture();
  for (let peer = 0; peer < LIMITS.peers; peer++) {
    const current = client(`peer-${peer}`);
    for (let index = 0; index < 8; index++) {
      data(current);
      send(host, {type: 'data', peer: current.peer, data: 'AA'});
    }
  }
  for (let sequence = 128; sequence >= 1; sequence--) ack(host, sequence);
  assert.equal(host.frames, 256);
  assert.equal(host.pending.size, 0);
  assert.equal(tunnel.host, host);
  assert.equal(tunnel.peers.size, LIMITS.peers);
});

test('host-requested peer close also retires its pending tokens', () => {
  const {tunnel, host, client, data, send} = fixture();
  const current = client('peer');
  data(current);
  send(host, {type: 'closed', peer: 'peer'});
  assert.equal(tunnel.peers.size, 0);
  assert.equal(host.pending.size, 0);
  assert.equal(current.inflight, 0);
});

test('slow downstream client is disconnected without closing the host or another peer', () => {
  const {tunnel, host, client, send} = fixture();
  const slow = client('slow');
  const fast = client('fast');
  for (let index = 0; index < 9; index++) send(host, {type: 'data', peer: slow.peer, data: 'AA'});
  assert.equal(tunnel.host, host);
  assert.equal(tunnel.peers.has(slow.peer), false);
  assert.equal(slow.pending.size, 0);
  send(host, {type: 'data', peer: fast.peer, data: 'AA'});
  assert.equal(fast.pending.size, 1);
  assert.deepEqual(host.closes, []);
});

test('failed downstream send rolls back reservation and isolates the failed target', () => {
  const {tunnel, host, client, send} = fixture();
  const broken = client('broken');
  const healthy = client('healthy');
  broken.socket.send = () => { throw Error('disconnected'); };
  send(host, {type: 'data', peer: broken.peer, data: 'AA'});
  assert.equal(broken.pending.size, 0);
  assert.equal(tunnel.peers.has(broken.peer), false);
  assert.equal(tunnel.host, host);
  send(host, {type: 'data', peer: healthy.peer, data: 'AA'});
  assert.equal(healthy.pending.size, 1);
});

test('failed host send clears reservations, inflight credit and all dead-target connections', () => {
  const {tunnel, host, client, data} = fixture();
  const current = client('peer');
  host.socket.send = () => { throw Error('disconnected'); };
  data(current);
  assert.equal(host.pending.size, 0);
  assert.equal(current.inflight, 0);
  assert.equal(tunnel.host, null);
  assert.equal(tunnel.peers.size, 0);
});

test('failed delivered notification cannot leave the origin occupying host credit', () => {
  const {tunnel, host, client, data, ack} = fixture();
  const broken = client('broken');
  const healthy = client('healthy');
  data(broken);
  data(broken);
  data(healthy);
  broken.socket.send = () => { throw Error('disconnected'); };
  ack(host, 1);
  assert.equal(tunnel.peers.has('broken'), false);
  assert.deepEqual([...host.pending.keys()], [3]);
  assert.equal(broken.inflight, 0);
  assert.equal(healthy.inflight, 1);
  assert.equal(tunnel.host, host);
});

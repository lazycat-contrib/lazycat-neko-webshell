// Original application relay; protocol references are documented in ../../docs/protocol.md.
// Opaque session records, encrypted signaling and transport acknowledgements only.
import metadata from '../package.json' with { type: 'json' };

export const LIMITS = Object.freeze({ message: 98_304, peers: 16, framesPerSecond: 256, buffered: 512 * 1024 });
const VERSION = 3;
const PROTOCOL = `neko.remoted.v${VERSION}`;
const ROUTE = /^\/v3\/(host|client)\/([A-Za-z0-9_-]{43})$/;
const WINDOW = 8;
const json = (status, code) => Response.json({ code }, { status, headers: { "cache-control": "no-store" } });
const validRoute = s => /^[A-Za-z0-9_-]{43}$/.test(s) && canonical32(s);
function canonical32(s) {
  try { const b = Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/") + "="), c => c.charCodeAt(0)); return b.length === 32 && encode(b) === s; } catch { return false; }
}
function encode(b) { return btoa(String.fromCharCode(...b)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); }
export async function authorizeHost(header, route) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const secret = header.slice(7);
  if (!validRoute(secret)) return false;
  const b = Uint8Array.from(atob(secret.replaceAll("-", "+").replaceAll("_", "/") + "="), c => c.charCodeAt(0));
  const hash = encode(new Uint8Array(await crypto.subtle.digest("SHA-256", b)));
  let diff = hash.length ^ route.length;
  for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ (route.charCodeAt(i) || 0);
  return diff === 0;
}
export default {
  async fetch(request, env) {
    const u = new URL(request.url);
    if (u.pathname === "/" && !u.search) {
      if (request.method !== "GET") return json(405, "METHOD_NOT_ALLOWED");
      const buildValue = value => typeof value === "string" && value.trim() ? value : "unknown";
      return Response.json({
        service: metadata.name, package_version: metadata.version,
        relay_protocol: PROTOCOL, protocol_version: VERSION,
        build_commit: buildValue(env.RELAY_BUILD_COMMIT),
        build_time: buildValue(env.RELAY_BUILD_TIME),
      }, { headers: { "cache-control": "no-store" } });
    }
    if (request.method === "GET" && u.pathname === "/healthz" && !u.search) {
      const health = { protocol: PROTOCOL, version: VERSION };
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return Response.json(health, { headers: { "cache-control": "no-store" } });
      if (!request.headers.get("sec-websocket-protocol")?.split(",").map(x => x.trim()).includes(PROTOCOL)) return json(400, "PROTOCOL_REQUIRED");
      const pair = new WebSocketPair();
      pair[1].accept();
      pair[1].send(JSON.stringify(health));
      pair[1].close(1000, "Healthy");
      return new Response(null, {status: 101, webSocket: pair[0], headers: {"sec-websocket-protocol": PROTOCOL}});
    }
    const match = ROUTE.exec(u.pathname);
    if (!match || !validRoute(match[2]) || u.search) return json(404, "NOT_FOUND");
    if (request.method !== "GET") return json(405, "METHOD_NOT_ALLOWED");
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return json(426, "WEBSOCKET_REQUIRED");
    if (!request.headers.get("sec-websocket-protocol")?.split(",").map(x => x.trim()).includes(PROTOCOL)) return json(400, "PROTOCOL_REQUIRED");
    const [_, role, route] = match;
    if (role === "host" && !await authorizeHost(request.headers.get("authorization"), route)) return json(401, "BAD_HOST_CREDENTIAL");
    // One global admission object bounds traffic before arbitrary per-route DOs are created.
    const gate = env.ADMISSION.get(env.ADMISSION.idFromName("admission-v2"));
    const allowed = await gate.fetch(new Request("https://admission/check", { method: "POST", headers: { "x-source-ip": request.headers.get("cf-connecting-ip") || "local", "x-role": role } }));
    if (!allowed.ok) return json(429, "RATE_LIMITED");
    const tunnel = env.TUNNELS.get(env.TUNNELS.idFromName(route));
    return tunnel.fetch(request);
  }
};

export class Admission {
  constructor() { this.windows = new Map(); }
  fetch(request) {
    const now = Math.floor(Date.now() / 60_000);
    const ip = request.headers.get("x-source-ip") || "unknown";
    const role = request.headers.get("x-role");
    const key = `${role}:${ip}`;
    if (this.windows.size >= 4096) { for (const [k, v] of this.windows) if (v.minute !== now) this.windows.delete(k); }
    if (!this.windows.has(key) && this.windows.size >= 4096) return json(429, "RATE_LIMITED");
    const old = this.windows.get(key);
    const slot = old?.minute === now ? old : { minute: now, count: 0 };
    slot.count++; this.windows.set(key, slot);
    return new Response(null, { status: slot.count <= (role === "host" ? 30 : 60) ? 204 : 429 });
  }
}

export class Tunnel {
  constructor(state, env) {
    this.state = state; this.env = env;
    this.host = null; this.peers = new Map(); this.generation = 0;
    this.registered = false;
    state.blockConcurrencyWhile(async () => { this.registered = await state.storage.get("registered") === true; });
  }
  async fetch(request) {
    const url = new URL(request.url);
    const match = ROUTE.exec(url.pathname);
    if (!match || !validRoute(match[2]) || url.search) return json(404, "NOT_FOUND");
    if (request.method !== "GET") return json(405, "METHOD_NOT_ALLOWED");
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return json(426, "WEBSOCKET_REQUIRED");
    if (!request.headers.get("sec-websocket-protocol")?.split(",").map(value => value.trim()).includes(PROTOCOL)) return json(400, "PROTOCOL_REQUIRED");
    const role = match[1];
    if (role === "host") {
      // Recheck at the authority as well; no caller-supplied role header is trusted.
      if (!await authorizeHost(request.headers.get("authorization"), match[2])) return json(401, "BAD_HOST_CREDENTIAL");
      if (!this.registered && this.env.REGISTRATION_KEY && request.headers.get("x-remoted-registration-key") !== this.env.REGISTRATION_KEY) return json(403, "REGISTRATION_DENIED");
      if (!this.registered) { await this.state.storage.put("registered", true); this.registered = true; }
    } else {
      if (!this.host) return json(503, "HOST_OFFLINE");
      if (this.peers.size >= LIMITS.peers) return json(429, "PEER_LIMIT");
    }
    const pair = new WebSocketPair(); const [client, socket] = Object.values(pair);
    socket.accept();
    const generation = role === "host" ? this.generation + 1 : this.generation;
    const peer = role === "client" ? crypto.randomUUID() : null;
    const record = { socket, peer, generation, second: 0, frames: 0, hello: false, sent: 0, inflight: 0, pending: new Map(), role };
    socket.addEventListener("message", event => this.message(role, record, event.data));
    socket.addEventListener("close", () => this.closed(role, record));
    socket.addEventListener("error", () => this.disconnect(role, record, 1011, "Connection failed"));
    if (role === "host") {
      const old = this.host;
      if (old) this.closed("host", old);
      this.generation = generation; this.host = record;
      if (old) close(old.socket, 4000, "Host replaced");
      this.notify(record, { type: "connected", peer: "host" });
    } else {
      this.peers.set(peer, record);
      if (this.notify(record, { type: "connected", peer })) this.notify(this.host, { type: "opened", peer });
    }
    return new Response(null, { status: 101, webSocket: client, headers: { "sec-websocket-protocol": PROTOCOL } });
  }
  message(role, record, data) {
    if (record.generation !== this.generation || (role === "host" && record !== this.host) || (role === "client" && this.peers.get(record.peer) !== record)) return close(record.socket, 1008, "Stale connection");
    const second = Math.floor(Date.now()/1000);
    if (record.second !== second) { record.second = second; record.frames = 0; }
    if (++record.frames > LIMITS.framesPerSecond || typeof data !== "string" || data.length > LIMITS.message || new TextEncoder().encode(data).byteLength > LIMITS.message) return this.reject(role,record);
    let frame; try { frame = JSON.parse(data); } catch { return this.reject(role,record); }
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) return this.reject(role,record);
    if (frame.type === "ping" && typeof frame.nonce === "string" && frame.nonce.length <= 64 && Object.keys(frame).length === 2) {
      return this.notify(record,{ type:"pong",nonce:frame.nonce });
    }
    if (frame.type === "acknowledge") {
      if (frame.peer !== (role === "host" ? "host" : record.peer) || !Number.isSafeInteger(frame.sequence) || frame.sequence <= 0 || frame.sequence > record.sent || Object.keys(frame).some(key => !["type", "peer", "sequence"].includes(key))) return this.reject(role, record);
      // Issued tokens are never reused on this socket. A consumed or retired
      // token is an idempotent no-op, including ACKs crossing peer cancellation.
      if (!record.pending.has(frame.sequence)) return;
      const origin = record.pending.get(frame.sequence);
      record.pending.delete(frame.sequence);
      if (origin.role === "client") origin.inflight--;
      this.notify(origin, { type: "delivered", peer: role === "client" ? record.peer : origin.peer, count: 1 });
      return;
    }
    if (role === "client" && frame.type === "hello" && !record.hello && ["pair","connect"].includes(frame.mode) && Object.keys(frame).every(k=>["type","mode","peer"].includes(k))) {
      record.hello=true;
      return this.forward(role,record,this.host,{type:"hello",peer:record.peer,mode:frame.mode});
    }
    if (frame.type === "data" && typeof frame.data === "string" && frame.data.length <= 87382 && /^[A-Za-z0-9_-]*$/.test(frame.data) && Object.keys(frame).every(k=>["type","peer","data","sequence"].includes(k))) {
      if (role === "client") {
        if (!record.hello) return this.reject(role,record);
        return this.forward(role,record,this.host,{type:"data",peer:record.peer,data:frame.data});
      }
      if (typeof frame.peer !== "string") return this.reject(role, record);
      const p=this.peers.get(frame.peer);
      if (p) return this.forward(role,record,p,{type:"data",peer:p.peer,data:frame.data});
      return; // A client may already have detached.
    }
    if (role === "host" && frame.type === "closed" && typeof frame.peer === "string" && Object.keys(frame).every(k=>["type","peer"].includes(k))) {
      const p=this.peers.get(frame.peer);if(p)this.disconnect("client",p,1000,"Disconnected by host");return;
    }
    this.reject(role,record);
  }
  forward(role,record,target,frame) {
    if (!target) return this.reject(role,record);
    if (frame.type === "data" && role === "client" && record.inflight >= WINDOW) return this.reject(role,record);
    // ACK credits bound buffering even on Workers where bufferedAmount is absent.
    if ((target.socket.bufferedAmount || 0)>LIMITS.buffered || (frame.type === "data" && target.pending.size >= (target.role === "host" ? LIMITS.peers * WINDOW : WINDOW))) {
      if (role === "host") { this.reject("client",target); } else { this.reject(role,record); }
      return;
    }
    if (frame.type === "data") {
      if (!Number.isSafeInteger(target.sent + 1)) return this.disconnect(target.role, target, 1011, "Delivery token exhausted");
      frame.sequence = ++target.sent;
      target.pending.set(frame.sequence, record);
      if (role === "client") record.inflight++;
    }
    try { send(target, frame); }
    catch {
      if (frame.type === "data") {
        target.pending.delete(frame.sequence);
        if (role === "client") record.inflight--;
      }
      this.disconnect(target.role, target, 1011, "Delivery failed");
    }
  }
  notify(record, frame) {
    try { send(record, frame); return true; }
    catch { this.disconnect(record.role, record, 1011, "Delivery failed"); return false; }
  }
  disconnect(role,record,code,reason) { this.closed(role,record);close(record.socket,code,reason); }
  reject(role,record) { this.disconnect(role,record,1008,"Invalid or excessive messages"); }
  closed(role,record) {
    if(role === "host") {
      if(this.host !== record) return;
      this.host=null;
      record.pending?.clear();
      for(const p of this.peers.values()) {
        p.pending?.clear(); p.inflight = 0;
        close(p.socket,1012,"Host offline");
      }
      this.peers.clear();
    } else if(this.peers.get(record.peer) === record) {
      this.peers.delete(record.peer);
      record.pending?.clear();
      record.inflight = 0;
      if(this.host?.generation===record.generation) {
        for (const [sequence, origin] of this.host.pending) if (origin === record) this.host.pending.delete(sequence);
        this.notify(this.host,{type:"closed",peer:record.peer});
      }
    }
  }
}
function send(record,frame){record.socket.send(JSON.stringify(frame));}
function close(socket,code,reason){try{socket.close(code,reason);}catch{}}

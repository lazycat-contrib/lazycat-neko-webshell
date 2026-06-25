# Protocol Notes

## Data Plane

`/ws/terminal` is the terminal hot path. It is intentionally not protobuf:

- binary WebSocket frames carry PTY bytes from backend to frontend;
- binary or text frames carry user input from frontend to backend;
- JSON text frames carry resize and close controls;
- backend sends JSON text frames for `ready`, `error`, `process-exit`, `output-sequence`, and `replay-complete`.

Reconnect replay uses `/ws/terminal?...&replay=true&after=<last_sequence>`. PTY bytes still travel as raw binary frames; the following `output-sequence` control frame identifies the monotonic output sequence that was just delivered. The frontend queues input while replay is active and flushes it after `replay-complete`.

Accepted client text messages:

```json
{"type":"input","data":"ls\r"}
{"type":"resize","cols":120,"rows":32}
{"type":"close"}
```

Compatibility shorthands are also accepted:

```text
input:<bytes>
resize:<cols>,<rows>
```

## Control Plane

`lazycat.webshell.v1.CapabilityService` owns typed control APIs:

- `ListInstances`
- `GetProvider`
- `CreateSession`
- `CloseSession`
- `ListSessions`
- `ListPlugins`
- `ConfigurePlugin`
- `InvokePlugin`
- `RequestControl`
- `ReleaseControl`

The browser uses Connect over HTTP for these APIs. This avoids forcing terminal byte streams through browser-limited request streaming while keeping platform operations typed.

`CloseSession` accepts `session_id` and an optional `selector`. Provider-local workspace sessions can be closed with the session ID alone. Agent-managed sessions require the selector when the provider has no local workspace record, so the close request is routed to the correct instance-local agent instead of scanning or waking unrelated instances.

Agent-managed close is explicit lifecycle cleanup: the agent resolves `session_id -> pane -> owning tab`, removes that pane from workspace state, closes the pane PTY, and repairs orphan panes that are no longer referenced by any tab. Non-active tabs or panes are not treated as idle and are not cleaned up unless they become unreachable orphan objects.

## Generic Plugin Protocol

Plugins are described with:

- stable `id`;
- generic `kind`;
- `scopes`;
- accepted and produced content types;
- JSON schema strings for input/output payloads;
- enablement state;
- string metadata.

Plugin invocation is opaque:

```protobuf
message InvokePluginRequest {
  string plugin_id = 1;
  string session_id = 2;
  string operation = 3;
  string content_type = 4;
  bytes payload = 5;
  map<string, string> metadata = 6;
}
```

This keeps the protocol stable while future implementations add concrete handlers for file transfer, remote shell adapters, AI control, or human collaboration workflows.

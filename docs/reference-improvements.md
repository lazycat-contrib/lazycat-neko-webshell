# Reference WebShell improvements

The comparison uses the current `lazycat-microserver-webshell` source and the
current Neko implementation, rather than assuming their terminal engines or
LightOS integration are interchangeable.

## Implemented

| Reference capability | Neko change | Boundary |
| --- | --- | --- |
| Mobile remote desktop preference in debug settings (`runtime/static/settings/settings_controller.js`, `instances/instances_navigation.js`) | Adds the browser-local preference and carries `mobile_remote_desktop=1/0` when returning to LightOS home. | Mobile settings and host navigation; LightOS still owns the desktop service. |
| Connection/init timing and terminal timelines (`runtime/static/diagnostics/README.md`) | Adds a built-in Terminal Diagnostics plugin with connection/replay events, task timing, manual refresh, copy and JSON download. | The host supplies only anonymous trace/counter snapshots. Default off, bounded data, no sampling timers or terminal contents. |

The diagnostic plugin complements the existing debug tools. Each has its own
collection lease; switching one off does not stop the other. Collection clears
when both are off, and disposal stops it. Timeline events begin when collection
starts; runtime task totals cover the current page. The view shows the latest
40 events, while exports include the bounded retained trace.

## Further candidates

| Capability | Benefit and required work |
| --- | --- |
| Online devices and optional heartbeat (`runtime/static/devices`) | Shows which devices are connected. Needs host-owned account/target authorization, expiring presence records and page lifecycle handling before a UI plugin can consume it. |
| LightOS service publishing (`runtime/static/service_forwarding`) | Manages persistent HTTP service entries. This differs from Neko's transient LightOS forward and public tunnel tools; a plugin would need a narrow authenticated Publish API adapter, explicit public-access confirmation and rollback handling. |
| Long terminal screenshots (`runtime/static/terminal/screenshot`) | Exports scrollback across several image segments. Needs a Restty-compatible read-only snapshot contract and geometry/session identity checks; the reference renderer cannot be copied directly. |

These candidates are not exposed as controls in this release. They require their
own host resource contracts and runtime verification rather than placeholder UI.

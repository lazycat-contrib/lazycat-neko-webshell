# LightOS mobile remote desktop preference

Settings → Terminal → Debug mode exposes **Allow remote desktop on mobile**
when the provider is running with LightOS integration. It defaults off and is
saved only in this browser under `lightos-mobile-remote-desktop-enabled`, matching
the reference WebShell. A blocked storage API keeps the selection for the current
page. It is not an account-wide application preference.

The debug switch controls access to the setting. Turning debug mode off hides
its controls and stops the existing terminal trace, while preserving the mobile
desktop preference, just as the reference does.

Returning with the Home button resolves the admin address through the existing
`/api/lightos-admin-info` flow, then navigates in the current page with
`view=home` and `mobile_remote_desktop=1` or `0`. The referrer fallback carries the
same explicit preference. LightOS owns the remote desktop entry and connection;
the WebShell does not create a desktop session or change terminal behavior.

Mobile UI, local persistence and its controller live under
`src/frontend/src/mobile/settings/remote-desktop-*`. Shared LightOS return URL
handling remains in `lightos-navigation.ts`; `main.ts` only wires the setting,
runtime availability and navigation.

Verification covers persistence/defaults/blocked storage, admin and fallback
URLs, desktop/mobile settings visibility and an actual browser Home navigation.
Showing and connecting the remote desktop itself requires a LightOS instance
that supports the `mobile_remote_desktop` preference.

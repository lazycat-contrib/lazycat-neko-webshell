# Settings and tools UI smoke

Run `npm run test:browser -- settings-ui` from the repository root.

The scenario loads the real application through an owned Vite server and an in-memory API fixture. It covers settings and AI subtab keyboard navigation, modal focus and Escape behavior, plugin disclosure persistence and toggle focus, phone and landscape bounds, light mode, reduced motion, and tool navigation labels. It does not contact LightOS, SSH hosts, or AI providers.

Screenshots are written to `tests-auto/artifacts/settings-ui`. For a manual preview, run `node tests-auto/settings-ui/preview-server.mjs` and open the printed URL.

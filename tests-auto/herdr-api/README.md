# Herdr 0.9 API smoke

Run `HERDR_TEST_BINARY=/absolute/path/to/herdr-0.9.0 python3 tests-auto/herdr-api/run.py` from the repository root. This does not call lzc-cli.

The test owns a temporary Herdr configuration/socket, shell pane and Git repository/worktree. It checks integration.list, real output search with content revisions, selection.read, and the ordinary-close refusal followed by explicit close_group on that isolated group. No existing user session or repository is used. The temporary server is stopped in finally; bounded socket reads and subprocess timeouts prevent hangs.

Ignored artifacts/herdr-api directories record the selected binary version and API results. These local Linux tests do not replace physical device or remote LightOS coverage.

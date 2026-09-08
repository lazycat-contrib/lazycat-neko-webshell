# Herdr history dialog and clipboard regression

Run `npm run test:browser -- herdr-history`. The fixture loads the actual history controller/view with a delayed static SockAPI response. No Herdr or target device is contacted.

The test checks a real promise-backed ClipboardItem write started during the copy click, permission-rejection fallback with the temporary textarea inside the native modal, and complete clipboard denial retaining the selectable preview. It also checks Tab/Shift+Tab cycling, Escape focus return and a Chinese 375px screenshot. It temporarily replaces clipboard/execCommand methods only inside its owned browser page; native writes/fallback still run in the successful cases.

Run the separate herdr-api Python smoke for real Herdr content revisions. Local Chromium proves call ordering and its clipboard behavior; physical Safari/iOS, Android and LightOS remain outside this environment's coverage. Artifacts live under ignored `tests-auto/artifacts/herdr-history/`.

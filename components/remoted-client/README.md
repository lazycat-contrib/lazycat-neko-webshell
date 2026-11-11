# Native client publisher

This component publishes only the Android arm64-v8a native client. It has an independent
`remoted-client-vX.Y.Z` tag namespace. The existing application publisher remains separate.

Run `publish-remoted-client.yml` manually on the public repository's `main` branch with
the native `version`, explicit private `source-run-id`, and exact 40-character
`source-commit`. `dry-run` defaults to `true`. No scheduled publication is configured.
`SOURCE_REPO_TOKEN` needs read access to Actions and metadata in the private source
repository. Publication uses the public workflow's own `GITHUB_TOKEN`.

The source must be a completed, successful `remoted-client.yml` push or manual run on
the matching `remoted-client-vX.Y.Z` private tag, whose current commit must equal the
run head and the explicitly supplied commit. Pull requests, forks, branches, moved
tags, expired or ambiguous native artifacts, and missing GitHub archive digests fail.
Revalidation repeats these checks after Android inspection and before publication.

The artifact name is `remoted-client-native-vX.Y.Z`. Its ZIP has exactly three flat files:

- `neko-remoted-client-vX.Y.Z-android-arm64.apk`
- `checksums.txt`: exactly `<lowercase APK SHA256>  <APK filename>\n`
- `provenance.json`: the exact flat schema validated by `scripts/prepare-remoted-native.py`

All provenance fields are mandatory; additional or duplicate JSON keys are rejected.
`schemaVersion`, `protocolVersion`, `sourceRunId`, `sourceRunAttempt`, `apkSize`,
`versionCode`, `minSdk`, and `targetSdk` are positive JSON integers. `debuggable` is
the JSON boolean `false`. All other fields are strings. `sourceWorkflow` is the
basename `remoted-client.yml`; `sourceRef` is the full `refs/tags/remoted-client-vX.Y.Z`.
`version` equals the APK version name. `sourceCommit` has 40 lowercase hex digits;
APK and signing-certificate SHA256 fields have 64 lowercase hex digits without colons.

The profile pins the package, protocol, API levels, ABI, build tools, and stable
production signing certificate. A null, missing, malformed, or all-zero fingerprint
fails even a dry run. The publisher independently checks APK metadata and ARM64 ELF
content, then invokes SDK 35.0.1 `apksigner verify --verbose --print-certs`.
It does not trust provenance claims about the APK signature. Debuggable APKs and
Android debug certificates are forbidden. Archive download, extraction, entry counts,
APK expansion, and Android-tool runtime/output are bounded.

With `dry-run=false`, the script first checks existing native tags and Release assets.
It never moves tags or overwrites differing assets. New Releases remain drafts until
all three attachments have been uploaded and downloaded back with matching hashes.
Identical partial releases can resume. A native Release does not change GitHub's
Latest release and does not submit anything to either application store.

## Public source synchronization

The public `remoted/` tree contains the client, protocol, Relay, documentation and
their build support. The WebShell host implementation is supplied by the installed
application; its private `src/remoted/` directory is not published here.

After each source synchronization, preserve or reapply the public adaptation in
`remoted/README.md`: its directory table lists only public directories and describes
the host as an application capability, without a `../src/remoted/` reference. Check
relative Markdown links against the public checkout after the final synchronization.
Do not copy private host source merely to satisfy a documentation reference. Keep
the existing Neko documentation and the root README's native-client and Cloudflare
deployment links intact. This documentation adaptation does not change the artifact
provenance: publication still verifies the exact private source commit and run.

Local checks:

```sh
python3 -m unittest discover -s scripts -p 'test_remoted_native.py'
node --test scripts/remoted-client.test.cjs
actionlint .github/workflows/*remoted-client.yml
```

These tests cover local validation and mocked GitHub responses. A real private run,
artifact download, dry-run dispatch and publication require separate runtime evidence.

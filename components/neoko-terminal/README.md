# neoko-terminal publisher

This component publishes only the neoko-terminal Android arm64-v8a client. It has an independent
`neoko-terminal-android-vX.Y.Z` tag namespace. The existing application publisher remains separate.

Run `publish-neoko-terminal-android.yml` manually on the public repository's `main` branch with
the native `version`, explicit private `source-run-id`, and exact 40-character
`source-commit`. `dry-run` defaults to `true`. No scheduled publication is configured.
`SOURCE_REPO_TOKEN` needs read access to Actions, Contents (including Git refs/tags),
and Metadata in the private source repository. Publication uses the public workflow's own `GITHUB_TOKEN`.

The source must be a completed, successful `neoko-terminal-android.yml` push or manual run on
the matching `neoko-terminal-android-vX.Y.Z` private tag, whose current commit must equal the
run head and the explicitly supplied commit. Pull requests, forks, branches, moved
tags, expired or ambiguous native artifacts, and missing GitHub archive digests fail.
Revalidation repeats these checks after Android inspection and before publication.

The public publisher reads private Actions artifacts using `SOURCE_REPO_TOKEN`.
Check the current repository, workflow, run, tag and artifact endpoints with that
credential rather than carrying forward a historical permissions diagnosis. A real
API denial must remain an explicit error; never skip source or immutable-tag checks.
Local verification may use an existing authorized login without writing its token
to files or CI configuration.

The artifact name is `neoko-terminal-android-vX.Y.Z`. Its ZIP has exactly three flat files:

- `neoko-terminal-vX.Y.Z-android-arm64.apk`
- `checksums.txt`: exactly `<lowercase APK SHA256>  <APK filename>\n`
- `provenance.json`: the exact flat schema validated by `scripts/prepare-neoko-terminal.py`

All provenance fields are mandatory; additional or duplicate JSON keys are rejected.
The provenance `component` is exactly `neoko-terminal`.
`schemaVersion`, `protocolVersion`, `sourceRunId`, `sourceRunAttempt`, `apkSize`,
`versionCode`, `minSdk`, and `targetSdk` are positive JSON integers. The current application protocol is exactly 2; `schemaVersion` remains 1. `debuggable` is
the JSON boolean `false`. All other fields are strings. `sourceWorkflow` is the
basename `neoko-terminal-android.yml`; `sourceRef` is the full `refs/tags/neoko-terminal-android-vX.Y.Z`.
`version` equals the APK version name. `sourceCommit` has 40 lowercase hex digits;
APK and signing-certificate SHA256 fields have 64 lowercase hex digits without colons.

The APK also embeds `assets/build-inputs.json` with exactly five fields:
`source_sha`, `source_dirty`, `ghostty_source_revision`,
`ghostty_wrapper_revision`, and `zig_version`. The source must match the selected
private commit and be clean; the three toolchain values must equal the public
profile's fixed pins. Missing metadata, extra fields, dirty sources and pin drift
fail before publication. The private build includes Ghostty and third-party
licenses; the public publisher does not rebuild the APK.

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

Both native workflows accept an optional `release-commit` public SHA. Leave it
blank for normal publication: the tag uses the workflow's current main commit
(`context.sha`). To resume a Release whose tag was already fixed before a public
maintenance commit, supply that original full lowercase SHA. The publisher checks
through the public compare API that it is an ancestor of the trusted main workflow
commit; malformed, unrelated or newer commits fail, including in dry runs. An
explicit SHA equal to the workflow commit is also accepted. The existing public
tag must match the selected release commit before uploads and before publication;
no tag is moved. Private source provenance remains independently pinned and checked.

The historical desktop `0.3.0` release uses public commit
`cf1e4d64e520fa5133ec742b63f4b3a316dc42ae`; that tag remains immutable.
New versions normally leave `release-commit` blank.

## Desktop private-build publication

The public `neoko-terminal-desktop.yml` is a publisher, not a source builder. Run it
manually on public `main` with `version` (default `0.4.0`), `source-run-id`,
`source-commit` and `dry-run` (default `true`). It fetches artifacts from the private
`neoko-terminal-desktop.yml` successful run on the exact immutable
`neoko-terminal-desktop-vX.Y.Z` tag. There is no public Cargo build or package rebuild.

`desktop-profile.json` pins the repositories, workflow, tag and artifact namespaces,
application ID, crate version (`0.3.0`), NSH revision and these four targets:

- `x86_64-unknown-linux-gnu`
- `x86_64-pc-windows-msvc`
- `aarch64-apple-darwin`
- `x86_64-apple-darwin`

Exactly four Actions artifacts are required, each named
`neoko-terminal-desktop-X.Y.Z-<target>`, with a nonexpired GitHub SHA256 archive digest
and matching run/repository/commit/tag identity. Each ZIP contains exactly three
flat regular files:

- `neoko-terminal-X.Y.Z-<target>.deb` (Linux) or `.zip` (Windows/macOS)
- The package filename plus `.sha256`, containing only its exact SHA256 entry
- `neoko-terminal-X.Y.Z-<target>.build-info.json`

The build-info JSON is the private build script's provenance schema. It must bind
the version, target, exact source SHA, clean source (`source_dirty: false`), pinned
NSH revision, pinned crate version and a valid Cargo binary SHA256, and contain only
the expected fields. The shared `scripts/neoko_terminal_desktop_package.py` verifier
also inspects package contents: Linux Debian control metadata, executable ELF64
x86_64 and its SHA256, desktop entry, icon and runtime dependencies; Windows x64
PE32+ GUI executable, its SHA256 and absent certificate directory; and macOS thin
Mach-O architecture, bundle plist identity/version and ad-hoc signed code-page
hashes. Ghostty source, Rust binding and Zig pins must match the public profile. Package-internal build-info must equal the sidecar. Opaque packages fail
even when outer digests and sidecars match. Windows/Linux packages are unsigned;
macOS is not Developer ID signed or notarized. Package verification does not claim
target-machine runtime acceptance. It never executes a downloaded package.
Android's actual `apksigner` checks are unchanged.

Desktop inspection and its CI regression suite run on Python 3.14 so the standard
library can read the Debian package's zstd-compressed tar members. Package checksum
sidecars must contain exactly the expected SHA256, two spaces and package filename,
followed by LF; Windows also accepts its native CRLF line ending. Additional lines
or whitespace changes fail.

All four archives pass bounded extraction and provenance checks before any of the
12 files are promoted. Source selection is repeated before publication. Only those
12 exact files may enter the desktop Release; public tags are immutable, differing
assets are never overwritten, every attachment is downloaded back and hashed before
a new draft becomes public, and GitHub Latest is unchanged. Dry runs make no tag or
Release writes. A private run without a successful completion or all four artifacts
cannot be published, even if some targets have already uploaded their ZIPs.

The desktop application ID and Android package name stay
`community.lazycat.neko.remoted`; the Android production certificate pin is unchanged.
Existing `remoted-client-*` tags and Releases remain historical and are never moved
or renamed. Only the new namespaces are accepted for new publications.

## Public repository scope

The public repository maintains GitHub Actions workflows, publisher scripts,
component profiles and release metadata, plus the [Relay source](../../relay/README.md),
its tests and [Cloudflare deployment guide](../../relay/DEPLOY.md). Relay checks
use [check-relay.yml](../../.github/workflows/check-relay.yml) and the root `relay/` path.

Application, native-client and standalone protocol source remain in the private
repository and are not synchronized into this public checkout. Both native
publishers download private Actions build artifacts and verify their exact source
commit, current private tag, trusted run, archive digests and package provenance.
Public source cleanup does not change these checks or require a public client build.

When updating public release support, keep publisher workflows, scripts, profiles
and metadata together, and check relative links against the public checkout.
Relay source updates belong under `relay/`; use its deployment guide for the current
working directory and configuration paths.

Local checks (Python 3.14 is required for the zstd regression):

```sh
python3 -m unittest discover -s scripts -p 'test_neoko_terminal*.py'
node --test scripts/neoko-terminal.test.cjs scripts/neoko-terminal-desktop.test.cjs
actionlint .github/workflows/*neoko-terminal*.yml
```

These tests cover local validation and mocked GitHub responses. A real private run,
artifact download, dry-run dispatch and publication require separate runtime evidence.

# Android app host

The Android application owns `community.lazycat.neko.remoted.RemotedActivity`.
It embeds the actual `com.longbridge.nsh.NshView`, calls `runRustApp("nsh")`,
and destroys the view with the Activity. The install identity is permanently
`community.lazycat.neko.remoted`; minimum Android is API 28, target API 35,
and the APK contains only `arm64-v8a`. There is no WebView or JavaScript UI.

## Build

```sh
export ANDROID_HOME="$HOME/Android/Sdk"
export NSH_TOOLCHAIN="$HOME/src/nsh"
remoted/client/scripts/build-android.sh
remoted/client/scripts/test-android.sh
```

Required inputs are JDK, Rust with `aarch64-linux-android`, Android SDK
`platforms;android-35`, `build-tools;35.0.1`, NDK `27.3.13750724`, curl,
unzip, openssl, and the matching NSH CLI and Android `classes.jar`.
SDK location defaults to `$HOME/Android/Sdk`; set `ANDROID_HOME` or
`ANDROID_SDK_ROOT` for another location. `NSH_TOOLCHAIN` must explicitly name
the matching NSH checkout (the revision pinned in `client/Cargo.toml`).
Build that checkout's CLI with `cargo build -p nsh-cli`, and its Android
runtime with `cargo xtask android --abi arm64-v8a` (consult that revision's
`cargo xtask android --help` for supported ABI flags). Building NSH from source
also requires libclang discoverable by bindgen (`LIBCLANG_PATH` when needed)
and that checkout's documented host dependencies. The expected Java input
is `$NSH_TOOLCHAIN/target/android/debug/classes.jar`; the CLI is
`$NSH_TOOLCHAIN/target/debug/nsh`. Alternatively, explicitly provide both
`NSH_ANDROID_RUNTIME` and `NSH_CLI` for prebuilt inputs. These inputs must
come from the same NSH revision. No public build default points at `/tmp`.
`NEKO_NDK_HOST` defaults to `linux-x86_64`; use the NDK host directory for
other supported build hosts. The script requires Bash 4+ and GNU sha256sum.

The runtime directory must contain `classes.jar`, `classes.dex`, and
`lib/arm64-v8a/libnsh.so`. The script passes this prebuilt runtime explicitly
to the NSH CLI, avoiding a second generic runtime build. The generic native
library supplies ABI availability only; the shipped library is rebuilt from
the application root in release mode.

The script compiles all app-owned Java alongside the runtime and ZXing into
DEX. It asks `nsh package --target android --abi arm64-v8a` to compile the
real Rust UI into `libnsh.so`, then repackages the library and assets with the
app's manifest and Java host. NSH's generated Android runner supplies
`nsh::main!(app_root())` and the backend dependency. The client itself needs
only `pub mod platform;` and Android-target `jni = "0.21"`; no extra root
macro, `JNI_OnLoad`, or `cdylib` declaration belongs in the client library.
No NSH source modification is needed.

For an already built, matching **app** library, set `NEKO_ANDROID_NATIVE_LIB`
to its `libnsh.so` and optionally `NEKO_ANDROID_ASSETS` to its assets directory.
The generic prebuilt runtime is insufficient for the Rust UI. The build rejects
libraries missing the Rust root or either app JNI export. It aligns and signs
the final APK, verifies its signature and ZIP alignment, checks every native
PT_LOAD alignment is at least 0x4000, and prints package metadata and the
public certificate fingerprint. `build-info.json` records APK/native/runtime
hashes, ZXing hash, public signing certificate SHA-256, package/API/ABI and
alignment verification; `signature.txt` contains apksigner verification output.

Output is `remoted/client/target/android-app/neko-remoted.apk`; override with
`NEKO_ANDROID_OUT`. The manifest does not mark the application debuggable.
Native optimization follows `nsh package`'s release build.

## Signing and dependencies

The first build generates a stable RSA signing key and random password under
`${XDG_DATA_HOME:-$HOME/.local/share}/neko-remoted/signing/`, outside the
repository. The directory is mode 0700 and new key/password files use umask
0077. Keep both files securely: losing this key prevents upgrading existing
installations. The build reuses them on subsequent runs.

For a separately managed release key, set `NEKO_ANDROID_KEYSTORE`,
`NEKO_ANDROID_KEY_ALIAS`, and `NEKO_SIGNING_PASSWORD`. Passwords are passed to
keytool/apksigner through environment-variable arguments, never command-line
values. Signing keys and password files must never be committed.

ZXing Core is pinned to `com.google.zxing:core:3.5.3`, downloaded over HTTPS
from Maven Central, and checked against SHA-256
`8d8064c1636fdaef7189dd9055c7d59950a8940a12f2293956446ec3c109fd82`.
Its Apache-2.0 license and attribution are in `client/android/licenses/` and
copied into the APK's `assets/licenses/`. The JAR is cached outside the repo.

The redistributed NSH runtime and Java embedding are from Longbridge's NSH
revision `0e4a20bd41ee72a35515cecbf9a7fba88742d911`, matching the Cargo pin.
`android/licenses/NSH-LICENSE-APACHE` is an unchanged copy of that revision's
`LICENSE-APACHE`. It and the shared `NOTICE` containing Longbridge attribution
and the revision are packaged alongside the ZXing license in `assets/licenses/`.
No NSH source changes are applied. The app's MIT license is copied directly
from `remoted/LICENSE` into `assets/licenses/NEKO-LICENSE`. The build verifies
all four license/notice assets byte for byte inside the signed APK.

## Rust and JNI contract

`client/src/platform.rs` owns the Android JNI boundary. Functions are async
and their futures are `Send`. Call from the controller's Tokio runtime.
Java dispatches picker/camera actions on the UI thread and storage/stream
operations through one worker thread. Requests have unique positive IDs,
at most 64 outstanding requests, and a five-minute response deadline.
Cancellation of a pending Rust request dismisses its camera/picker operation.

Java exports to Rust:

```java
static native void nativeAttach(PlatformBridge bridge, String noBackupDirectory);
static native void nativeEvent(long requestId, String replyJson);
```

JNI symbols are
`Java_community_lazycat_neko_remoted_PlatformBridge_nativeAttach` and
`Java_community_lazycat_neko_remoted_PlatformBridge_nativeEvent`.
They are exported from the app-linked `libnsh.so`, whose existing NSH
`JNI_OnLoad` is retained. Rust stores a global reference to the Java bridge,
attaches Rust threads to the JVM as needed, and invokes
`PlatformBridge.request(String requestJson, long requestId)`.
Replies are `{"result":...}` or `{"error":"..."}`. No identity, code,
file content, or storage value is logged by the bridge.

High-level functions:

```rust
async fn scan_code() -> anyhow::Result<String>;
async fn secure_get(key: &str) -> anyhow::Result<Option<String>>;
async fn secure_set(key: &str, value: &str) -> anyhow::Result<()>;
fn data_dir() -> anyhow::Result<std::path::PathBuf>;
fn drain_events() -> Vec<serde_json::Value>;
async fn request(value: serde_json::Value) -> anyhow::Result<serde_json::Value>;
```

`data_dir()` is the app-private no-backup directory, **not an encrypted
filesystem**. Identity private keys and binding records must go through
`secure_get` / `secure_set`. Values up to 1 MiB are AES-256-GCM encrypted
with a nonexportable Android Keystore key, a fresh random 96-bit IV, and the
record name as authenticated additional data. Writes use AtomicFile.
Authentication failures, corrupted records, and unavailable keys are errors;
they never silently replace an existing identity. Backup is disabled.
Keystore hardware backing depends on the device; StrongBox is not required.

`scan_code` requests camera permission at runtime and decodes live NV21
camera luminance through ZXing's actual QR reader. It prefers the rear camera,
uses continuous autofocus where available, and bounds QR text to 8192 chars.
Cancellation, denied permission, camera failure, and interruption are errors.
The returned text still requires the protocol owner's device-code validation.

## Streaming SAF contract

`request(json!({...})).await` returns the JSON result directly, or an error.
Opaque handles belong to this Activity; there are at most four open streams.
No raw URI, filesystem path, or unrestricted storage permission crosses JNI.

| Request | Result |
| --- | --- |
| `{"op":"pickUpload"}` | `null` on cancellation; otherwise `{handle,name,size}` with size `-1` if unknown |
| `{"op":"read","handle":h,"size":32768}` | `{data,eof}`; `data` is URL-safe Base64 without padding; default/max 65536 bytes |
| `{"op":"seek","handle":h,"offset":0}` | `true`; reopen the selected input from its provider |
| `{"op":"close","handle":h}` | `true` after input close |
| `{"op":"pickDownload","name":"file.bin"}` | `null` on cancellation or `{handle,name,size}`; creates a private disk staging file |
| `{"op":"write","handle":h,"data":encoded}` | number of bytes written to staging, max 65536 decoded bytes per request |
| `{"op":"commit","handle":h}` | `true` after close, bounded-buffer copy to the selected SAF document, output close, and staging removal |
| `{"op":"cancel","handle":h}` | `true` after close and removal; a download also deletes its created SAF document |

Upload: select, hash by bounded reads, rewind with offset zero, send bounded
chunks, then close. Arbitrary seek offsets are deliberately unsupported so
cloud document providers work too. A provider may change the file between
passes: verify the transmitted length/hash against the first pass.

Download: select, receive bounded chunks into staging while hashing, verify
the expected length and hash, then commit. Never commit before verification.
On any error or explicit cancellation send `cancel`; report cleanup errors.
The stage uses disk space proportional to file size, not RAM. The bridge does
not implement network transfer, hashing policy, or automatic retry.

There are convenience `pick_upload()` and `save_download()` functions for
callers explicitly accepting whole-file memory. They cap files at 16 MiB.
The controller should use the streaming contract for normal file transfers.
After a picker returns a handle, the controller owns it and must close or
cancel it even if its transfer task is cancelled. Failed commit retains the
stage so the caller can cancel and report uncertain provider cleanup.

SAF providers cannot guarantee atomic replacement. Commit failure can leave
a partially written document; cancellation attempts provider deletion and
returns an error if deletion is not confirmed. A hard process kill may leave
an empty chosen document and a cached staging file. There is no promise of
successful cleanup without provider confirmation, and no transfer resume
after process death.

## Lifecycle and verification

`drain_events()` returns bounded lifecycle records such as
`{"lifecycle":"resumed"}`, `paused`, and `destroyed`. The controller owns
its response to backgrounding; the host does not synthesize network success
or silently reconnect. Opening a SAF picker pauses the Activity, so **do not
cancel all platform requests merely because `paused` was received**.
Camera resources are released on pause. Activity destruction rejects pending
requests, closes file streams, removes staged downloads where possible,
clears the JNI host reference, and calls `NshView.destroy()`. Rotation,
screen size, and keyboard visibility changes are handled without Activity
recreation. The app-owned `RemotedTheme` uses the platform light theme in
`values/` and dark theme in `values-night/`, including matching system-bar
icon appearances. A system light/dark change uses standard Activity recreation
so native NSH headers and dialogs receive a fresh themed context. Recreation
detaches the current transport and cancels Activity-owned transfers; encrypted
identity, bindings and last verified Relay survive, and remote PTYs are retained.
Attaching the new host clears the previous Activity's lifecycle queue so the
fresh controller cannot consume a stale destruction event. Unsaved form/view
state is not restored and reconnect remains explicit. Back first goes through
`NshView.handleBack()`.

`test-android.sh` compiles the complete Java host against the exact runtime,
checks real QR decoding, a rotated QR frame, and rejection of a blank frame,
and verifies API-28 DEX conversion. The build itself verifies the final APK
signature and required JNI exports. These checks do not replace device tests.

```sh
ANDROID_SERIAL=emulator-5554 remoted/client/scripts/test-android-device.sh
```

The device script builds and signs a **separate test APK** with the same key,
installs both APKs, and runs Android Instrumentation. It records output in
`target/android-app/device-tests.txt` and fails unless instrumentation returns
success. The harness verifies the real Activity and NshView, actual Android
Keystore encryption/decryption and GCM tamper rejection, a real DocumentsProvider
with URI grants, bounded upload/rewind and staged download/commit/cancel,
system picker cancellation, camera permission handling and live preview, and
Activity pause/resume. The fixture provider and grant Activity exist only in
the test APK; the production APK contains no test components. Remove it after
testing with `adb uninstall community.lazycat.neko.remoted.tests`.

The launcher/round icon reuses the repository's `icon.png` unchanged. Camera,
autofocus, and camera-any features are explicitly optional so manual pairing
works on devices without cameras.

Device acceptance must cover first launch; camera grant/deny/revoke and
rotation; scanning actual device codes; restart and persistence of binding;
Keystore failure; upload/download with local and cloud document providers;
checksum failure; user cancellation; insufficient disk space; provider errors;
background/foreground; and process death. A physical arm64 API-28+ device or
matching emulator is required for camera, Keystore, SAF, and visual checks.

### Recorded verification, November 12, 2026

The actual app-linked **release** arm64 APK was built, signed, installed, and
all nine instrumentation groups passed on the API-35 Google APIs emulator
`emulator-5554`, ABI list `x86_64,arm64-v8a` using native-bridge translation.
All four PT_LOAD segments of the actual app `libnsh.so` have alignment
`0x4000`; final APK ZIP alignment and v2/v3 signatures verified. The emulator
uses 4096-byte pages, so this is static 16-KiB compatibility verification,
not a runtime test on a 16-KiB kernel. The launcher icon and optional camera
features were verified in final APK badging.

The final rerun includes the native header/theme assertion and the latest
network receive hardening, recoverable request-error handling, local binding
forget, and the app-owned read-only terminal observer. All four license assets
were verified byte for byte from the signed APK. Light and dark screenshots are recorded beside
the APK as `theme-light.png` and `theme-dark.png`; switching the actual system
night mode rebuilt the host theme correctly without a stale disconnect banner.
The signing certificate stayed unchanged. `build-info.json` is the authority
for the final rebuilt APK hash.

Canonical NR1 DeviceCode and separate Unicode normal/rotated QR decoding
and blank-frame JVM tests passed. The Rust platform module
passed independent Android cross-check and Clippy with warnings denied;
its async `Send` contract test passed on the host and cross-compiled for
Android. Device tests exercised actual live camera preview, but did not scan
a physical pairing QR or test real cloud providers. Denied-permission result
handling was injected after a real permission grant; the system denial dialog
itself still needs manual acceptance coverage. API-28 hardware, hardware-backed
Keystore, a 16-KiB device, and abrupt process death remain untested.

The final release contains the UI owner's read-only input adaptation: only a
controlled writable pane mounts the NSH Terminal's private editor; other panes
render a selectable observer sharing its retained emulator. The UI owner's
headless tests cover input-node absence, selection and retained terminal state
across control changes. There is no approved connected host session here, so
actual Android read-only/control-grant keyboard and real-host terminal/file E2E
remain unverified. No production test authentication or debug route was added.

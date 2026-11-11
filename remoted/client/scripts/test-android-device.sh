#!/usr/bin/env bash
set -euo pipefail
for tool in dirname javac java jar mktemp rm mkdir cat tee grep; do
    command -v "$tool" >/dev/null || { echo "Missing required test tool: $tool" >&2; exit 1; }
done
client_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
sdk=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}
output=${NEKO_ANDROID_OUT:-$client_dir/target/android-app}
tools=$sdk/build-tools/35.0.1
adb=$sdk/platform-tools/adb
device=${ANDROID_SERIAL:-emulator-5554}
[[ -f "$output/neko-remoted.apk" ]] || { echo 'Build the real Android app first' >&2; exit 1; }
[[ -r "$sdk/platforms/android-35/android.jar" ]] || { echo 'Missing Android SDK platform' >&2; exit 1; }
for required in "$tools/d8" "$tools/aapt2" "$tools/zipalign" "$tools/apksigner" "$adb"; do
    [[ -x "$required" ]] || { echo "Missing Android test executable: $required" >&2; exit 1; }
done
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/classes" "$work/dex"
javac --release 8 -encoding UTF-8 -classpath "$sdk/platforms/android-35/android.jar" -d "$work/classes" "$client_dir/android/tests/FixtureDocuments.java" "$client_dir/android/tests/FixtureGrantActivity.java" "$client_dir/android/tests/PlatformInstrumentation.java"
jar cf "$work/tests.jar" -C "$work/classes" .
"$tools/d8" --release --min-api 28 --lib "$sdk/platforms/android-35/android.jar" --output "$work/dex" "$work/tests.jar"
"$tools/aapt2" link -I "$sdk/platforms/android-35/android.jar" --manifest "$client_dir/android/tests/AndroidManifest.xml" -o "$work/tests-unsigned.apk"
jar uf "$work/tests-unsigned.apk" -C "$work/dex" classes.dex
"$tools/zipalign" -f 4 "$work/tests-unsigned.apk" "$work/tests-aligned.apk"
signing_dir=${XDG_DATA_HOME:-$HOME/.local/share}/neko-remoted/signing
keystore=${NEKO_ANDROID_KEYSTORE:-$signing_dir/android.p12}
if [[ -z ${NEKO_ANDROID_KEYSTORE:-} ]]; then
    export NEKO_SIGNING_PASSWORD
    NEKO_SIGNING_PASSWORD=$(cat "$signing_dir/password")
else
    : "${NEKO_SIGNING_PASSWORD:?Set NEKO_SIGNING_PASSWORD}"
    export NEKO_SIGNING_PASSWORD
fi
"$tools/apksigner" sign --ks "$keystore" --ks-key-alias "${NEKO_ANDROID_KEY_ALIAS:-neko-remoted}" --ks-pass env:NEKO_SIGNING_PASSWORD --key-pass env:NEKO_SIGNING_PASSWORD --out "$output/neko-remoted-tests.apk" "$work/tests-aligned.apk"
"$adb" -s "$device" install -r "$output/neko-remoted.apk"
"$adb" -s "$device" install -r "$output/neko-remoted-tests.apk"
"$adb" -s "$device" shell am force-stop community.lazycat.neko.remoted
"$adb" -s "$device" shell am instrument -w -r community.lazycat.neko.remoted.tests/community.lazycat.neko.remoted.PlatformInstrumentation | tee "$output/device-tests.txt"
grep -Fx 'INSTRUMENTATION_CODE: -1' "$output/device-tests.txt" >/dev/null || { echo 'Android instrumentation failed' >&2; exit 1; }
! grep -E '^FAIL ' "$output/device-tests.txt"

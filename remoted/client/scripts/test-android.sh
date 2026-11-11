#!/usr/bin/env bash
set -euo pipefail
for tool in dirname javac java jar mktemp rm find sort; do
    command -v "$tool" >/dev/null || { echo "Missing required test tool: $tool" >&2; exit 1; }
done
client_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
sdk=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}
if [[ -z ${NSH_ANDROID_RUNTIME:-} && -z ${NSH_TOOLCHAIN:-} ]]; then
    echo 'Set NSH_TOOLCHAIN or NSH_ANDROID_RUNTIME to the matching Android runtime' >&2; exit 1
fi
runtime=${NSH_ANDROID_RUNTIME:-$NSH_TOOLCHAIN/target/android/debug}
zxing=${XDG_CACHE_HOME:-$HOME/.cache}/neko-remoted/android/zxing-core-3.5.3.jar
[[ -f "$zxing" ]] || { echo 'Run build-android.sh first to fetch the verified ZXing dependency' >&2; exit 1; }
for required in "$sdk/platforms/android-35/android.jar" "$runtime/classes.jar"; do
    [[ -r "$required" ]] || { echo "Missing Android test input: $required" >&2; exit 1; }
done
[[ -x "$sdk/build-tools/35.0.1/d8" ]] || { echo 'Missing Android d8 executable' >&2; exit 1; }
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mapfile -t sources < <(find "$client_dir/android/src" "$client_dir/android/tests" -name '*.java' -print | sort)
classpath=$sdk/platforms/android-35/android.jar:$runtime/classes.jar:$zxing
javac --release 8 -encoding UTF-8 -classpath "$classpath" -d "$work" "${sources[@]}"
java -classpath "$work:$classpath" community.lazycat.neko.remoted.ScannerDecodeTest
jar cf "$work/host-tests.jar" -C "$work" community
"$sdk/build-tools/35.0.1/d8" --release --min-api 28 --lib "$sdk/platforms/android-35/android.jar" --output "$work" "$work/host-tests.jar" "$runtime/classes.jar" "$zxing"

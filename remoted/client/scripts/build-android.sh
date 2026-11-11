#!/usr/bin/env bash
set -euo pipefail
for tool in dirname java javac jar keytool curl sha256sum cmp awk sed grep unzip mkdir mktemp rm find sort cp mv ln tee chmod openssl cat; do
    command -v "$tool" >/dev/null || { echo "Missing required build tool: $tool" >&2; exit 1; }
done
if [[ -z ${NEKO_ANDROID_NATIVE_LIB:-} ]]; then
    if [[ -n ${CARGO:-} ]]; then
        command -v "$CARGO" >/dev/null || { echo "Missing Cargo executable: $CARGO" >&2; exit 1; }
    else
        command -v rustup >/dev/null || { echo 'Missing required build tool: rustup' >&2; exit 1; }
        rustup which cargo >/dev/null
    fi
fi
client_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
sdk=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}
tools=$sdk/build-tools/35.0.1
android_jar=$sdk/platforms/android-35/android.jar
ndk_root=${ANDROID_NDK_HOME:-$sdk/ndk/27.3.13750724}
ndk_host=${NEKO_NDK_HOST:-linux-x86_64}
ndk_bin=$ndk_root/toolchains/llvm/prebuilt/$ndk_host/bin
[[ -r "$android_jar" ]] || { echo "Missing Android SDK platform: $android_jar" >&2; exit 1; }
for required in "$tools/aapt2" "$tools/d8" "$tools/apksigner" "$tools/zipalign" "$ndk_bin/llvm-nm" "$ndk_bin/llvm-readelf" "$ndk_bin/llvm-ar" "$ndk_bin/llvm-strip" "$ndk_bin/llvm-objdump" "$ndk_bin/aarch64-linux-android28-clang" "$ndk_bin/aarch64-linux-android28-clang++"; do
    [[ -x "$required" ]] || { echo "Missing Android SDK/NDK executable: $required" >&2; exit 1; }
done
if [[ ${1:-} == --check-tools && $# == 1 ]]; then
    echo 'Android build tool preflight passed'
    exit 0
fi
[[ $# == 0 ]] || { echo 'Usage: build-android.sh [--check-tools]' >&2; exit 1; }
toolchain=${NSH_TOOLCHAIN:-}
if [[ -z "$toolchain" && ( -z ${NSH_CLI:-} || -z ${NSH_ANDROID_RUNTIME:-} ) ]]; then
    echo 'Set NSH_TOOLCHAIN to the matching NSH checkout, or set both NSH_CLI and NSH_ANDROID_RUNTIME' >&2
    exit 1
fi
nsh_cli=${NSH_CLI:-$toolchain/target/debug/nsh}
runtime=${NSH_ANDROID_RUNTIME:-$toolchain/target/android/debug}
if [[ -z ${NEKO_ANDROID_NATIVE_LIB:-} ]]; then
    [[ -x "$nsh_cli" ]] || { echo "Missing NSH CLI executable: $nsh_cli" >&2; exit 1; }
fi
for required in "$runtime/classes.jar" "$runtime/classes.dex" "$runtime/lib/arm64-v8a/libnsh.so"; do
    [[ -r "$required" ]] || { echo "Missing Android runtime input: $required" >&2; exit 1; }
done
output=${NEKO_ANDROID_OUT:-$client_dir/target/android-app}
cache=${XDG_CACHE_HOME:-$HOME/.cache}/neko-remoted/android
mkdir -p "$output" "$cache"
zxing=$cache/zxing-core-3.5.3.jar
zxing_sha=8d8064c1636fdaef7189dd9055c7d59950a8940a12f2293956446ec3c109fd82
if [[ ! -f "$zxing" ]] || ! printf '%s  %s\n' "$zxing_sha" "$zxing" | sha256sum --check --status; then
    curl --fail --location --retry 3 --retry-all-errors --retry-delay 2 --retry-max-time 180 --connect-timeout 15 --max-time 60 --proto '=https' --tlsv1.2 https://repo.maven.apache.org/maven2/com/google/zxing/core/3.5.3/core-3.5.3.jar -o "$zxing.tmp"
    printf '%s  %s\n' "$zxing_sha" "$zxing.tmp" | sha256sum --check --status
    mv "$zxing.tmp" "$zxing"
fi
work=$(mktemp -d "$output/build.XXXXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/classes" "$work/dex" "$work/package/lib/arm64-v8a" "$work/package/assets/licenses"
mapfile -t java_sources < <(find "$client_dir/android/src" -name '*.java' -print | sort)
javac --release 8 -encoding UTF-8 -classpath "$android_jar:$runtime/classes.jar:$zxing" -d "$work/classes" "${java_sources[@]}"
jar cf "$work/host.jar" -C "$work/classes" .
"$tools/d8" --release --min-api 28 --lib "$android_jar" --output "$work/dex" "$work/host.jar" "$runtime/classes.jar" "$zxing"
if [[ -n ${NEKO_ANDROID_NATIVE_LIB:-} ]]; then
    native_lib=$NEKO_ANDROID_NATIVE_LIB
else
    export ANDROID_HOME=$sdk
    export ANDROID_NDK_HOME=${ANDROID_NDK_HOME:-$sdk/ndk/27.3.13750724}
    export CARGO=${CARGO:-$(rustup which cargo)}
    mkdir -p "$work/runtime/android"
    ln -s "$(cd "$runtime" && pwd)" "$work/runtime/android/release"
    export NSH_RUNTIME=$work/runtime
    "$nsh_cli" package "$client_dir" --target android --abi arm64-v8a --out "$work/base"
    mapfile -t base_apks < <(find "$work/base" -name '*.apk' -print)
    [[ ${#base_apks[@]} == 1 ]] || { echo 'Expected exactly one NSH base APK' >&2; exit 1; }
    unzip -q "${base_apks[0]}" 'lib/arm64-v8a/libnsh.so' 'assets/*' -d "$work/package"
    native_lib=$work/package/lib/arm64-v8a/libnsh.so
fi
[[ -f "$native_lib" ]] || { echo "Native app library missing: $native_lib" >&2; exit 1; }
for symbol in Java_com_longbridge_nsh_Native_runRust Java_community_lazycat_neko_remoted_PlatformBridge_nativeAttach Java_community_lazycat_neko_remoted_PlatformBridge_nativeEvent; do
    "$ndk_bin/llvm-nm" --dynamic --defined-only "$native_lib" | awk '{print $NF}' | grep -Fx "$symbol" >/dev/null || { echo "Native library lacks required app hook: $symbol" >&2; exit 1; }
done
"$ndk_bin/llvm-readelf" --file-header "$native_lib" | grep -E 'Machine:.*AArch64' >/dev/null || { echo 'Native library is not arm64' >&2; exit 1; }
mapfile -t load_alignments < <("$ndk_bin/llvm-readelf" --program-headers --wide "$native_lib" | awk '$1 == "LOAD" {print $NF}')
[[ ${#load_alignments[@]} -gt 0 ]] || { echo 'Native library has no PT_LOAD segments' >&2; exit 1; }
for alignment in "${load_alignments[@]}"; do
    (( alignment >= 0x4000 )) || { echo "Native PT_LOAD alignment is below 16 KiB: $alignment" >&2; exit 1; }
done
if [[ "$native_lib" != "$work/package/lib/arm64-v8a/libnsh.so" ]]; then
    cp "$native_lib" "$work/package/lib/arm64-v8a/libnsh.so"
fi
if [[ -n ${NEKO_ANDROID_ASSETS:-} ]]; then cp -R "$NEKO_ANDROID_ASSETS/." "$work/package/assets/"; fi
cp "$client_dir/android/licenses/ZXing-LICENSE" "$work/package/assets/licenses/ZXing-LICENSE"
cp "$client_dir/android/licenses/NSH-LICENSE-APACHE" "$work/package/assets/licenses/NSH-LICENSE-APACHE"
cp "$client_dir/android/licenses/NOTICE" "$work/package/assets/licenses/NOTICE"
cp "$client_dir/../LICENSE" "$work/package/assets/licenses/NEKO-LICENSE"
cp "$work/dex/"*.dex "$work/package/"
"$tools/aapt2" compile --dir "$client_dir/android/res" -o "$work/resources.zip"
"$tools/aapt2" link -I "$android_jar" --manifest "$client_dir/android/AndroidManifest.xml" "$work/resources.zip" -o "$work/unsigned.apk"
jar uf "$work/unsigned.apk" -C "$work/package" .
"$tools/zipalign" -P 16 -f 4 "$work/unsigned.apk" "$work/aligned.apk"
"$tools/zipalign" -c -P 16 4 "$work/aligned.apk"
signing_dir=${XDG_DATA_HOME:-$HOME/.local/share}/neko-remoted/signing
keystore=${NEKO_ANDROID_KEYSTORE:-$signing_dir/android.p12}
alias_name=${NEKO_ANDROID_KEY_ALIAS:-neko-remoted}
if [[ -z ${NEKO_ANDROID_KEYSTORE:-} ]]; then
    mkdir -p "$signing_dir"
    chmod 700 "$signing_dir"
    if [[ ! -f "$signing_dir/password" ]]; then (umask 077; openssl rand -hex 32 > "$signing_dir/password"); fi
    export NEKO_SIGNING_PASSWORD
    NEKO_SIGNING_PASSWORD=$(cat "$signing_dir/password")
    if [[ ! -f "$keystore" ]]; then
        (umask 077; keytool -genkeypair -keystore "$keystore" -storetype PKCS12 -alias "$alias_name" -keyalg RSA -keysize 3072 -validity 10000 -dname 'CN=Neko Remoted Android' -storepass:env NEKO_SIGNING_PASSWORD -keypass:env NEKO_SIGNING_PASSWORD)
    fi
else
    : "${NEKO_SIGNING_PASSWORD:?Set NEKO_SIGNING_PASSWORD for the supplied keystore}"
    export NEKO_SIGNING_PASSWORD
fi
"$tools/apksigner" sign --ks "$keystore" --ks-key-alias "$alias_name" --ks-pass env:NEKO_SIGNING_PASSWORD --key-pass env:NEKO_SIGNING_PASSWORD --out "$output/neko-remoted.apk" "$work/aligned.apk"
"$tools/apksigner" verify --verbose --print-certs "$output/neko-remoted.apk" | tee "$output/signature.txt"
"$tools/zipalign" -c -P 16 4 "$output/neko-remoted.apk"
for license in ZXing-LICENSE NSH-LICENSE-APACHE NOTICE; do
    unzip -p "$output/neko-remoted.apk" "assets/licenses/$license" | cmp "$client_dir/android/licenses/$license" -
done
unzip -p "$output/neko-remoted.apk" assets/licenses/NEKO-LICENSE | cmp "$client_dir/../LICENSE" -
certificate=$(sed -n 's/^Signer #1 certificate SHA-256 digest: //p' "$output/signature.txt")
[[ "$certificate" =~ ^[0-9a-fA-F]{64}$ ]] || { echo 'Could not read signing certificate fingerprint' >&2; exit 1; }
apk_sha=$(sha256sum "$output/neko-remoted.apk" | awk '{print $1}')
native_sha=$(sha256sum "$native_lib" | awk '{print $1}')
runtime_sha=$(sha256sum "$runtime/classes.jar" | awk '{print $1}')
printf '{"package":"community.lazycat.neko.remoted","minSdk":28,"targetSdk":35,"abi":"arm64-v8a","apk_sha256":"%s","native_sha256":"%s","runtime_classes_sha256":"%s","zxing_sha256":"%s","certificate_sha256":"%s","elf_load_alignment_min":16384,"zip_alignment_verified":true}\n' "$apk_sha" "$native_sha" "$runtime_sha" "$zxing_sha" "$certificate" > "$output/build-info.json"
"$tools/aapt2" dump badging "$output/neko-remoted.apk" | sed -n '1,8p'
printf 'APK: %s\n' "$output/neko-remoted.apk"

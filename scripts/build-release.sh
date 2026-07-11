#!/usr/bin/env bash
set -euo pipefail

content_dir="./dist/content"
rm -rf "${content_dir}"
mkdir -p "${content_dir}"

npm ci
npm run build

missing_packages=()
command -v musl-gcc >/dev/null || missing_packages+=(musl-tools)
command -v protoc >/dev/null || missing_packages+=(protobuf-compiler)
if ((${#missing_packages[@]} > 0)); then
  if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
    sudo apt-get update
    sudo apt-get install -y "${missing_packages[@]}"
  else
    echo "missing build dependencies: ${missing_packages[*]}" >&2
    exit 1
  fi
fi

rustup target list --installed | grep -q '^x86_64-unknown-linux-musl$' ||
  rustup target add x86_64-unknown-linux-musl

rust_lld="$(find "$(rustc --print sysroot)" -name rust-lld -type f -print -quit)"
if [[ -z "${rust_lld}" ]]; then
  echo "missing rust-lld in the active Rust toolchain" >&2
  exit 1
fi

CC_x86_64_unknown_linux_musl=musl-gcc \
  CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER="${rust_lld}" \
  RUSTFLAGS="-C target-feature=+crt-static" \
  cargo build --release --locked --target x86_64-unknown-linux-musl

cp target/x86_64-unknown-linux-musl/release/lazycat-neko-webshell \
  "${content_dir}/lazycat-neko-webshell"

#!/usr/bin/env bash
set -euo pipefail

content_dir="./dist/content"
rm -rf "${content_dir}"
mkdir -p "${content_dir}"

{
  printf 'LIGHTOS_REQUIRE_COOKIE_AUTH=%s\n' "${LIGHTOS_REQUIRE_COOKIE_AUTH:-true}"
  if [[ -n "${LIGHTOS_ADMIN_INTERNAL_BASE_URL:-}" ]]; then
    printf 'LIGHTOS_ADMIN_INTERNAL_BASE_URL=%s\n' "${LIGHTOS_ADMIN_INTERNAL_BASE_URL}"
  fi
} > "${content_dir}/.env"

npm ci
npm run build

protoc_version="31.1"
protoc_sha256="96553041f1a91ea0efee963cb16f462f5985b4d65365f3907414c360044d8065"
protoc_root="${PWD}/.lazycat-build/tools/protoc-${protoc_version}"
protoc_bin="${protoc_root}/bin/protoc"
if [[ ! -x "${protoc_bin}" ]]; then
  archive="${protoc_root}/protoc.zip"
  mkdir -p "${protoc_root}"
  curl --fail --location --retry 3 \
    --output "${archive}" \
    "https://github.com/protocolbuffers/protobuf/releases/download/v${protoc_version}/protoc-${protoc_version}-linux-x86_64.zip"
  printf '%s  %s\n' "${protoc_sha256}" "${archive}" | sha256sum --check --strict
  unzip -q -o "${archive}" -d "${protoc_root}"
  rm -f "${archive}"
fi
export PROTOC="${protoc_bin}"
"${PROTOC}" --version

missing_packages=()
command -v musl-gcc >/dev/null || missing_packages+=(musl-tools)
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
  NEKO_WEBSHELL_BUILD_AGENT_ONLY=1 \
  cargo build --release --locked --target x86_64-unknown-linux-musl \
    --bin lazycat-neko-webshell-agent

agent_binary="${PWD}/target/x86_64-unknown-linux-musl/release/lazycat-neko-webshell-agent"
CC_x86_64_unknown_linux_musl=musl-gcc \
  CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER="${rust_lld}" \
  RUSTFLAGS="-C target-feature=+crt-static" \
  NEKO_WEBSHELL_AGENT_BINARY="${agent_binary}" \
  cargo build --release --locked --target x86_64-unknown-linux-musl \
    --bin lazycat-neko-webshell

agent_bytes="$(stat -c '%s' "${agent_binary}")"
provider_binary="target/x86_64-unknown-linux-musl/release/lazycat-neko-webshell"
provider_bytes="$(stat -c '%s' "${provider_binary}")"
if ((agent_bytes <= 0 || agent_bytes >= provider_bytes)); then
  echo "invalid lightweight agent size: agent=${agent_bytes} provider=${provider_bytes}" >&2
  exit 1
fi

cp "${provider_binary}" \
  "${content_dir}/lazycat-neko-webshell"

#!/usr/bin/env bash
set -euo pipefail

node scripts/check-version-consistency.mjs

content_dir="./dist/content"
rm -rf "${content_dir}"
mkdir -p "${content_dir}"

{
  printf 'LIGHTOS_REQUIRE_COOKIE_AUTH=%s\n' "${LIGHTOS_REQUIRE_COOKIE_AUTH:-true}"
  if [[ -n "${LIGHTOS_ADMIN_INTERNAL_BASE_URL:-}" ]]; then
    printf 'LIGHTOS_ADMIN_INTERNAL_BASE_URL=%s\n' "${LIGHTOS_ADMIN_INTERNAL_BASE_URL}"
  fi
} > "${content_dir}/.env"
mkdir -p "${content_dir}/licenses"
cp vendor/restty/0.2.6/LICENSE "${content_dir}/licenses/restty-0.2.6-LICENSE"

npm ci
node scripts/export-restty-wasm.mjs
npm test
npm run build
cargo fmt --check
cargo test --locked

protoc_version="31.1"
protoc_sha256="96553041f1a91ea0efee963cb16f462f5985b4d65365f3907414c360044d8065"
protoc_root="${PWD}/.lazycat-build/tools/protoc-${protoc_version}"
protoc_bin="${PROTOC:-${protoc_root}/bin/protoc}"
if [[ -n "${PROTOC:-}" && ! -x "${protoc_bin}" ]]; then
  echo "PROTOC is not executable: ${protoc_bin}" >&2
  exit 1
fi
if [[ -z "${PROTOC:-}" && ! -x "${protoc_bin}" ]]; then
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
expected_agent_protocol="lazycat-neko-webshell-agent-v4"
actual_agent_protocol="$("${agent_binary}" version)"
if [[ "${actual_agent_protocol}" != "${expected_agent_protocol}" ]]; then
  echo "invalid lightweight agent protocol: expected=${expected_agent_protocol} actual=${actual_agent_protocol}" >&2
  exit 1
fi
actual_agent_version="$("${agent_binary}" agent-version)"
minimum_agent_version="$("${agent_binary}" minimum-supported-version)"
if [[ ! "${actual_agent_version}" =~ ^[1-9][0-9]*$ ]]; then
  echo "invalid lightweight agent version: ${actual_agent_version}" >&2
  exit 1
fi
if [[ ! "${minimum_agent_version}" =~ ^[1-9][0-9]*$ ]] ||
  ((actual_agent_version < minimum_agent_version)); then
  echo "invalid lightweight agent compatibility window: agent=${actual_agent_version} minimum=${minimum_agent_version}" >&2
  exit 1
fi
CC_x86_64_unknown_linux_musl=musl-gcc \
  CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER="${rust_lld}" \
  RUSTFLAGS="-C target-feature=+crt-static" \
  NEKO_WEBSHELL_AGENT_BINARY="${agent_binary}" \
  cargo build --release --locked --target x86_64-unknown-linux-musl \
    --bin lazycat-neko-webshell

agent_bytes="$(stat -c '%s' "${agent_binary}")"
provider_binary="target/x86_64-unknown-linux-musl/release/lazycat-neko-webshell"
provider_bytes="$(stat -c '%s' "${provider_binary}")"
provider_agent_protocol="$("${provider_binary}" agent version)"
provider_agent_version="$("${provider_binary}" agent agent-version)"
provider_minimum_agent_version="$("${provider_binary}" agent minimum-supported-version)"
if [[ "${provider_agent_protocol}" != "${actual_agent_protocol}" ]] ||
  [[ "${provider_agent_version}" != "${actual_agent_version}" ]] ||
  [[ "${provider_minimum_agent_version}" != "${minimum_agent_version}" ]]; then
  echo "provider and embedded agent compatibility metadata differ" >&2
  exit 1
fi
max_agent_bytes=$((16 * 1024 * 1024))
if ((agent_bytes <= 0 || agent_bytes > max_agent_bytes || agent_bytes * 3 >= provider_bytes)); then
  echo "invalid lightweight agent size: agent=${agent_bytes} provider=${provider_bytes}" >&2
  exit 1
fi

cp "${provider_binary}" \
  "${content_dir}/lazycat-neko-webshell"

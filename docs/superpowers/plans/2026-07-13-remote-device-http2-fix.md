# Remote Device HTTP/2 Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make remote-device workspace and terminal requests obtain a device API token over the HTTP/2 transport required by the official gRPC endpoint.

**Architecture:** Keep the existing `client:<id>` frontend and workspace dispatch unchanged. Extract the credential-independent request portion of device authentication for transport testing, force its reqwest client to HTTP/2, and verify it against an in-process HTTP/2 gRPC endpoint.

**Tech Stack:** Rust 2024, reqwest 0.12, rustls 0.23, h2 0.4, Tokio, Buffa protobuf messages, Cargo tests.

## Global Constraints

- Do not modify `src/frontend/src/main.ts`.
- Do not log terminal tickets, device tokens, certificates, signatures, cookies, or authorization headers.
- Keep JSON admin, ticket, workspace, and attachment transports unchanged.
- Real-device verification remains separate from build and unit-test verification.

---

### Task 1: Add an HTTP/2 device-auth regression test

**Files:**
- Modify: `Cargo.toml`
- Modify: `src/device_api_auth.rs`

**Interfaces:**
- Consumes: `DeviceAuthMaterial`, `RequestAuthTokenRequest`, and `RequestAuthTokenResponse` in `src/device_api_auth.rs`.
- Produces: `request_auth_token(device_api_url: &Url, material: DeviceAuthMaterial) -> Result<SecretString, DeviceApiAuthError>` for the mounted-credential wrapper and module tests.

- [ ] **Step 1: Extract the credential-independent request function**

Keep `resolve_auth_token` as the production entry point and move the signing, client construction, gRPC request, and response decoding into the internal function:

```rust
pub(crate) async fn resolve_auth_token(
    device_api_url: &Url,
) -> Result<SecretString, DeviceApiAuthError> {
    if !matches!(device_api_url.scheme(), "http" | "https") || device_api_url.host_str().is_none() {
        return Err(DeviceApiAuthError::InvalidUrl);
    }
    let material = load_auth_material(
        Path::new(BOX_CERT_PATH),
        Path::new(APP_CERT_PATH),
        Path::new(APP_KEY_PATH),
    )?;
    request_auth_token(device_api_url, material).await
}

async fn request_auth_token(
    device_api_url: &Url,
    material: DeviceAuthMaterial,
) -> Result<SecretString, DeviceApiAuthError> {
    let subject_serial = certificate_subject_serial(&material.app_cert_der)?;
    let signature = sign_subject_serial(&material.app_key_der, subject_serial.as_bytes())?;
    let request = RequestAuthTokenRequest {
        box_cert: Some(material.box_cert_pem.clone()),
        app_cert: Some(material.app_cert_pem.clone()),
        signature: Some(signature),
        ..Default::default()
    };
    let body = encode_grpc_request(&request)?;
    let endpoint = auth_endpoint(device_api_url)?;

    let mut identity_pem = material.app_cert_pem;
    if !identity_pem.ends_with(b"\n") {
        identity_pem.push(b'\n');
    }
    identity_pem.extend_from_slice(&material.app_key_pem);
    let identity = reqwest::Identity::from_pem(&identity_pem)
        .map_err(|error| DeviceApiAuthError::Credential(error.to_string()))?;
    let box_cert = reqwest::Certificate::from_pem(&material.box_cert_pem)
        .map_err(|error| DeviceApiAuthError::Credential(error.to_string()))?;
    let client = reqwest::Client::builder()
        .timeout(DEVICE_AUTH_TIMEOUT)
        .identity(identity)
        .add_root_certificate(box_cert)
        .danger_accept_invalid_certs(true)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| DeviceApiAuthError::Credential(error.to_string()))?;
    let response = client
        .post(endpoint)
        .header("content-type", "application/grpc")
        .header("te", "trailers")
        .header("grpc-timeout", "10S")
        .body(body)
        .send()
        .await
        .map_err(|error| DeviceApiAuthError::Request(error.to_string()))?;
    if !response.status().is_success() {
        return Err(DeviceApiAuthError::Response(format!(
            "HTTP {}",
            response.status()
        )));
    }
    if let Some(status) = response.headers().get("grpc-status")
        && status.as_bytes() != b"0"
    {
        return Err(DeviceApiAuthError::Response(format!(
            "gRPC status {}",
            status.to_str().unwrap_or("unknown")
        )));
    }
    let bytes = read_limited_body(
        response,
        MAX_GRPC_MESSAGE_BYTES + 5,
        "device authentication response",
    )
    .await
    .map_err(DeviceApiAuthError::Response)?;
    let decoded: RequestAuthTokenResponse = decode_grpc_response(&bytes)?;
    let token = decoded
        .token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| DeviceApiAuthError::Response("missing auth token".to_owned()))?;
    Ok(SecretString::from(token.to_owned()))
}
```

- [ ] **Step 2: Run existing device-auth tests after the refactor**

Run: `cargo test device_api_auth::tests`

Expected: all existing device-auth tests pass.

- [ ] **Step 3: Add local HTTP/2 test dependencies**

Add:

```toml
[dev-dependencies]
h2 = "0.4.14"
tokio-rustls = "0.26.4"
```

- [ ] **Step 4: Write the failing transport test**

Add a Tokio test named `requests_device_auth_tokens_over_http2`. It must:

```rust
#[tokio::test]
async fn requests_device_auth_tokens_over_http2() {
    use std::sync::Arc;

    use bytes::Bytes;
    use secrecy::ExposeSecret as _;
    use tokio::net::TcpListener;
    use tokio_rustls::TlsAcceptor;

    let certificates = rustls_pemfile::certs(&mut Cursor::new(TEST_CERTIFICATE))
        .collect::<Result<Vec<_>, _>>()
        .expect("server certificates");
    let private_key = rustls_pemfile::private_key(&mut Cursor::new(TEST_PRIVATE_KEY))
        .expect("server private key")
        .expect("server private key is present");
    let mut server_config = rustls23::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certificates, private_key)
        .expect("server TLS config");
    server_config.alpn_protocols = vec![b"h2".to_vec()];

    let listener = TcpListener::bind("127.0.0.1:0").await.expect("test listener");
    let address = listener.local_addr().expect("test address");
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.expect("accepted connection");
        let tls = TlsAcceptor::from(Arc::new(server_config))
            .accept(stream)
            .await
            .expect("TLS handshake");
        let mut connection = h2::server::handshake(tls).await.expect("HTTP/2 handshake");
        let (request, mut respond) = connection
            .accept()
            .await
            .expect("HTTP/2 request")
            .expect("request stream");
        assert_eq!(request.uri().path(), REQUEST_AUTH_TOKEN_PATH);

        let mut body = request.into_body();
        let mut request_frame = Vec::new();
        while let Some(chunk) = body.data().await {
            request_frame.extend_from_slice(&chunk.expect("request data"));
        }
        let decoded = decode_grpc_response::<RequestAuthTokenRequest>(&request_frame)
            .expect("decoded auth request");
        assert!(decoded.box_cert.as_deref().is_some_and(|value| !value.is_empty()));
        assert!(decoded.app_cert.as_deref().is_some_and(|value| !value.is_empty()));
        assert!(decoded.signature.as_deref().is_some_and(|value| !value.is_empty()));

        let response_frame = encode_grpc_request(&RequestAuthTokenResponse {
            token: Some("device-token".to_owned()),
            ..Default::default()
        })
        .expect("response frame");
        let response = http::Response::builder()
            .status(200)
            .header("content-type", "application/grpc")
            .body(())
            .expect("response");
        let mut stream = respond.send_response(response, false).expect("response stream");
        stream.send_data(Bytes::from(response_frame), false).expect("response data");
        let mut trailers = http::HeaderMap::new();
        trailers.insert("grpc-status", http::HeaderValue::from_static("0"));
        stream.send_trailers(trailers).expect("response trailers");
    });

    let app_cert_der = first_certificate_der(TEST_CERTIFICATE).expect("certificate DER");
    let app_key_der = first_private_key_der(TEST_PRIVATE_KEY).expect("private key DER");
    let material = DeviceAuthMaterial {
        box_cert_pem: TEST_CERTIFICATE.to_vec(),
        app_cert_pem: TEST_CERTIFICATE.to_vec(),
        app_key_pem: TEST_PRIVATE_KEY.to_vec(),
        app_cert_der,
        app_key_der,
    };
    let url = Url::parse(&format!("https://{address}")).expect("device API URL");
    let token = request_auth_token(&url, material).await.expect("device auth token");

    assert_eq!(token.expose_secret(), "device-token");
    server.await.expect("HTTP/2 server task");
}
```

The server must use the existing test certificate and private key constants. It must not read `/lzcapp/run/certs`.

- [ ] **Step 5: Run the new test and verify RED**

Run: `cargo test device_api_auth::tests::requests_device_auth_tokens_over_http2 -- --nocapture`

Expected: FAIL because the current reqwest dependency negotiates HTTP/1.1 and cannot complete the HTTP/2-only exchange.

- [ ] **Step 6: Commit the regression test**

```bash
git add Cargo.toml Cargo.lock src/device_api_auth.rs
git commit -m "test: cover http2 device authentication"
```

### Task 2: Enable and enforce HTTP/2 for device authentication

**Files:**
- Modify: `Cargo.toml`
- Modify: `Cargo.lock`
- Modify: `src/device_api_auth.rs`

**Interfaces:**
- Consumes: the failing `requests_device_auth_tokens_over_http2` test.
- Produces: an HTTP/2-only reqwest client for the official device permission gRPC call.

- [ ] **Step 1: Enable reqwest HTTP/2**

Change the reqwest dependency to:

```toml
reqwest = { version = "0.12.24", default-features = false, features = ["http2", "json", "rustls-tls", "stream"] }
```

- [ ] **Step 2: Force the device authentication client to HTTP/2**

Add `.http2_prior_knowledge()` only to the client built inside `request_auth_token`:

```rust
let client = reqwest::Client::builder()
    .timeout(DEVICE_AUTH_TIMEOUT)
    .identity(identity)
    .add_root_certificate(box_cert)
    .danger_accept_invalid_certs(true)
    .redirect(reqwest::redirect::Policy::none())
    .http2_prior_knowledge()
    .build()
    .map_err(|error| DeviceApiAuthError::Credential(error.to_string()))?;
```

- [ ] **Step 3: Add safe boundary tracing**

Log only the sanitized origin and stage:

```rust
tracing::debug!(device_origin = %device_api_origin(device_api_url), "requesting device API auth token");
```

After a token is decoded, emit a second debug event without the token value. `device_api_origin` must return only scheme, host, and optional port.

```rust
fn device_api_origin(device_api_url: &Url) -> String {
    device_api_url.origin().ascii_serialization()
}
```

- [ ] **Step 4: Run the transport test and verify GREEN**

Run: `cargo test device_api_auth::tests::requests_device_auth_tokens_over_http2 -- --nocapture`

Expected: PASS and return `device-token`.

- [ ] **Step 5: Verify the dependency feature graph**

Run: `cargo tree -e features -i reqwest@0.12.28`

Expected: output contains `reqwest feature "http2"`.

- [ ] **Step 6: Commit the fix**

```bash
git add Cargo.toml Cargo.lock src/device_api_auth.rs
git commit -m "fix: use http2 for remote device auth"
```

### Task 3: Run repository verification

**Files:**
- Verify only; no planned source changes.

**Interfaces:**
- Consumes: the HTTP/2 regression guard and production transport fix.
- Produces: evidence that the targeted fix does not break Rust or frontend behavior.

- [ ] **Step 1: Run focused remote-terminal tests**

Run: `cargo test device_api_auth::tests && cargo test client_terminal::tests && cargo test lightos_admin::tests`

Expected: all selected tests pass.

- [ ] **Step 2: Run the complete Rust suite and Clippy**

Run: `cargo test --all-targets`

Expected: all tests pass.

Run: `cargo clippy --all-targets --all-features -- -D warnings`

Expected: no warnings.

- [ ] **Step 3: Run frontend verification**

Run from `src/frontend`: `npm test && npm run typecheck && npm run build`

Expected: frontend tests, type checking, and production build pass.

- [ ] **Step 4: Check the change surface**

Run: `git diff --check origin/main..HEAD && git status --short`

Expected: no whitespace errors and a clean worktree.

- [ ] **Step 5: Record the runtime handoff**

Real-device acceptance path: open the instance switcher, select the running remote device, confirm its workspace replaces the local workspace, open or attach a pane, and verify terminal output. If deployment access is unavailable, report this exact check as pending.

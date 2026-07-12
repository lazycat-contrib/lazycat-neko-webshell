use std::io::Cursor;
use std::path::Path;
use std::time::Duration;

use buffa::Message;
use ed25519_dalek::Signer as _;
use reqwest::Url;
use rsa::pkcs8::DecodePrivateKey as _;
use secrecy::SecretString;
use thiserror::Error;
use x509_parser::parse_x509_certificate;

use crate::proto::cloud::lazycat::apis::localdevice::{
    RequestAuthTokenRequest, RequestAuthTokenResponse,
};

const BOX_CERT_PATH: &str = "/lzcapp/run/certs/box.crt";
const APP_CERT_PATH: &str = "/lzcapp/run/certs/app.crt";
const APP_KEY_PATH: &str = "/lzcapp/run/certs/app.key";
const REQUEST_AUTH_TOKEN_PATH: &str =
    "/cloud.lazycat.apis.localdevice.PermissionManager/RequestAuthToken";
const DEVICE_AUTH_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_GRPC_MESSAGE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Error)]
pub(crate) enum DeviceApiAuthError {
    #[error("device API URL is invalid")]
    InvalidUrl,
    #[error("failed to load LazyCat device credentials: {0}")]
    Credential(String),
    #[error("failed to sign LazyCat device authentication request: {0}")]
    Signature(String),
    #[error("device authentication request failed: {0}")]
    Request(String),
    #[error("device authentication response is invalid: {0}")]
    Response(String),
}

struct DeviceAuthMaterial {
    box_cert_pem: Vec<u8>,
    app_cert_pem: Vec<u8>,
    app_key_pem: Vec<u8>,
    app_cert_der: Vec<u8>,
    app_key_der: Vec<u8>,
}

pub(crate) async fn resolve_auth_token(
    device_api_url: &Url,
) -> Result<SecretString, DeviceApiAuthError> {
    if device_api_url.scheme() != "https" || device_api_url.host_str().is_none() {
        return Err(DeviceApiAuthError::InvalidUrl);
    }
    let material = load_auth_material(
        Path::new(BOX_CERT_PATH),
        Path::new(APP_CERT_PATH),
        Path::new(APP_KEY_PATH),
    )?;
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
    let bytes = response
        .bytes()
        .await
        .map_err(|error| DeviceApiAuthError::Response(error.to_string()))?;
    let decoded: RequestAuthTokenResponse = decode_grpc_response(&bytes)?;
    let token = decoded
        .token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| DeviceApiAuthError::Response("missing auth token".to_owned()))?;
    Ok(SecretString::from(token.to_owned()))
}

fn load_auth_material(
    box_cert_path: &Path,
    app_cert_path: &Path,
    app_key_path: &Path,
) -> Result<DeviceAuthMaterial, DeviceApiAuthError> {
    let box_cert_pem = std::fs::read(box_cert_path)
        .map_err(|error| DeviceApiAuthError::Credential(error.to_string()))?;
    let app_cert_pem = std::fs::read(app_cert_path)
        .map_err(|error| DeviceApiAuthError::Credential(error.to_string()))?;
    let app_key_pem = std::fs::read(app_key_path)
        .map_err(|error| DeviceApiAuthError::Credential(error.to_string()))?;
    let app_cert_der = first_certificate_der(&app_cert_pem)?;
    let app_key_der = first_pkcs8_key_der(&app_key_pem)?;
    Ok(DeviceAuthMaterial {
        box_cert_pem,
        app_cert_pem,
        app_key_pem,
        app_cert_der,
        app_key_der,
    })
}

fn first_certificate_der(pem: &[u8]) -> Result<Vec<u8>, DeviceApiAuthError> {
    let mut reader = Cursor::new(pem);
    rustls_pemfile::certs(&mut reader)
        .next()
        .transpose()
        .map_err(|error| DeviceApiAuthError::Credential(error.to_string()))?
        .map(|certificate| certificate.as_ref().to_vec())
        .ok_or_else(|| DeviceApiAuthError::Credential("app certificate is missing".to_owned()))
}

fn first_pkcs8_key_der(pem: &[u8]) -> Result<Vec<u8>, DeviceApiAuthError> {
    let mut reader = Cursor::new(pem);
    loop {
        let item = rustls_pemfile::read_one(&mut reader)
            .map_err(|error| DeviceApiAuthError::Credential(error.to_string()))?;
        match item {
            Some(rustls_pemfile::Item::Pkcs8Key(key)) => {
                return Ok(key.secret_pkcs8_der().to_vec());
            }
            Some(_) => {}
            None => {
                return Err(DeviceApiAuthError::Credential(
                    "PKCS#8 application key is missing".to_owned(),
                ));
            }
        }
    }
}

fn certificate_subject_serial(certificate_der: &[u8]) -> Result<String, DeviceApiAuthError> {
    let (_, certificate) = parse_x509_certificate(certificate_der)
        .map_err(|error| DeviceApiAuthError::Credential(error.to_string()))?;
    certificate
        .subject()
        .iter_attributes()
        .find(|attribute| attribute.attr_type().to_id_string() == "2.5.4.5")
        .and_then(|attribute| attribute.as_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| {
            DeviceApiAuthError::Credential(
                "application certificate subject serial number is missing".to_owned(),
            )
        })
}

fn sign_subject_serial(key_der: &[u8], message: &[u8]) -> Result<Vec<u8>, DeviceApiAuthError> {
    if let Ok(key) = ed25519_dalek::SigningKey::from_pkcs8_der(key_der) {
        return Ok(key.sign(message).to_bytes().to_vec());
    }
    if let Ok(key) = rsa::RsaPrivateKey::from_pkcs8_der(key_der) {
        return key
            .sign(rsa::Pkcs1v15Sign::new_unprefixed(), message)
            .map_err(|error| DeviceApiAuthError::Signature(error.to_string()));
    }
    Err(DeviceApiAuthError::Signature(
        "unsupported PKCS#8 application key".to_owned(),
    ))
}

fn auth_endpoint(device_api_url: &Url) -> Result<Url, DeviceApiAuthError> {
    let mut endpoint = device_api_url.clone();
    endpoint.set_path(REQUEST_AUTH_TOKEN_PATH);
    endpoint.set_query(None);
    endpoint.set_fragment(None);
    Ok(endpoint)
}

fn encode_grpc_request<M: Message>(message: &M) -> Result<Vec<u8>, DeviceApiAuthError> {
    let payload = message.encode_to_vec();
    if payload.len() > MAX_GRPC_MESSAGE_BYTES {
        return Err(DeviceApiAuthError::Request(
            "gRPC request is too large".to_owned(),
        ));
    }
    let length = u32::try_from(payload.len())
        .map_err(|_| DeviceApiAuthError::Request("gRPC request is too large".to_owned()))?;
    let mut frame = Vec::with_capacity(payload.len() + 5);
    frame.push(0);
    frame.extend_from_slice(&length.to_be_bytes());
    frame.extend_from_slice(&payload);
    Ok(frame)
}

fn decode_grpc_response<M: Message>(frame: &[u8]) -> Result<M, DeviceApiAuthError> {
    if frame.len() < 5 || frame[0] != 0 {
        return Err(DeviceApiAuthError::Response(
            "invalid gRPC message frame".to_owned(),
        ));
    }
    let length = u32::from_be_bytes(
        frame[1..5]
            .try_into()
            .map_err(|_| DeviceApiAuthError::Response("invalid gRPC length".to_owned()))?,
    ) as usize;
    if length > MAX_GRPC_MESSAGE_BYTES || frame.len() != length + 5 {
        return Err(DeviceApiAuthError::Response(
            "invalid gRPC message length".to_owned(),
        ));
    }
    M::decode_from_slice(&frame[5..])
        .map_err(|error| DeviceApiAuthError::Response(error.to_string()))
}

#[cfg(test)]
mod tests {
    use buffa::Message as _;
    use ed25519_dalek::pkcs8::DecodePrivateKey as _;

    use super::{
        auth_endpoint, certificate_subject_serial, decode_grpc_response, encode_grpc_request,
        first_certificate_der, first_pkcs8_key_der, sign_subject_serial,
    };
    use crate::proto::cloud::lazycat::apis::localdevice::{
        RequestAuthTokenRequest, RequestAuthTokenResponse,
    };

    const TEST_CERTIFICATE: &[u8] = br#"-----BEGIN CERTIFICATE-----
MIIBjTCCAT+gAwIBAgIURRF9ld3m2w2chhT+8aREz8AEtQIwBQYDK2VwMDwxFTAT
BgNVBAMMDExhenlDYXQgVGVzdDEjMCEGA1UEBRMaY2xvdWQubGF6eWNhdC5hcHAu
dGVzdC5ib3gwHhcNMjYwNzEyMDAyMDM2WhcNMjYwNzEzMDAyMDM2WjA8MRUwEwYD
VQQDDAxMYXp5Q2F0IFRlc3QxIzAhBgNVBAUTGmNsb3VkLmxhenljYXQuYXBwLnRl
c3QuYm94MCowBQYDK2VwAyEAD59Tl8xJQ0zrG9BWzsXPaSHsRnWG9lqycSwBuA/W
NAqjUzBRMB0GA1UdDgQWBBSYxUASl6M6yAs6ePBOUjlaUma7JDAfBgNVHSMEGDAW
gBSYxUASl6M6yAs6ePBOUjlaUma7JDAPBgNVHRMBAf8EBTADAQH/MAUGAytlcANB
AICgoyqw11ZgyEpME3p9aeR7oQSa1J3rF7A2dELkBigo3CwfQI8R5wxH+S5EODbO
zSoT75z2Ej4IuMb8fQuGOAg=
-----END CERTIFICATE-----
"#;
    const TEST_PRIVATE_KEY: &[u8] = br#"-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIOPLhoJvUyNema3Oa/LQBHbNYdcteXVD4crUbB/dsIzb
-----END PRIVATE KEY-----
"#;

    #[test]
    fn grpc_frame_round_trips_official_auth_messages() {
        let request = RequestAuthTokenRequest {
            box_cert: Some(b"box-cert".to_vec()),
            app_cert: Some(b"app-cert".to_vec()),
            signature: Some(b"signature".to_vec()),
            ..Default::default()
        };

        let frame = encode_grpc_request(&request).expect("request frame");
        assert_eq!(frame[0], 0);
        let payload_len = u32::from_be_bytes(frame[1..5].try_into().expect("length"));
        assert_eq!(payload_len as usize, frame.len() - 5);

        let response = RequestAuthTokenResponse {
            token: Some("device-token".to_owned()),
            ..Default::default()
        };
        let response_frame = encode_grpc_request(&response).expect("response frame");
        let decoded: RequestAuthTokenResponse =
            decode_grpc_response(&response_frame).expect("decoded response");
        assert_eq!(decoded.token.as_deref(), Some("device-token"));
        assert_eq!(
            RequestAuthTokenRequest::decode_from_slice(&frame[5..]).expect("decoded request"),
            request
        );
    }

    #[test]
    fn signs_the_application_certificate_subject_serial() {
        let certificate_der = first_certificate_der(TEST_CERTIFICATE).expect("certificate DER");
        let key_der = first_pkcs8_key_der(TEST_PRIVATE_KEY).expect("private key DER");
        let subject_serial =
            certificate_subject_serial(&certificate_der).expect("subject serial number");
        assert_eq!(subject_serial, "cloud.lazycat.app.test.box");

        let signature =
            sign_subject_serial(&key_der, subject_serial.as_bytes()).expect("signature");
        let key = ed25519_dalek::SigningKey::from_pkcs8_der(&key_der).expect("signing key");
        let signature = ed25519_dalek::Signature::from_slice(&signature).expect("signature bytes");
        key.verifying_key()
            .verify_strict(subject_serial.as_bytes(), &signature)
            .expect("valid signature");
    }

    #[test]
    fn builds_the_official_device_permission_endpoint_without_carrying_query_data() {
        let base =
            reqwest::Url::parse("https://device.example/root?ticket=secret").expect("device URL");
        let endpoint = auth_endpoint(&base).expect("auth endpoint");

        assert_eq!(
            endpoint.as_str(),
            "https://device.example/cloud.lazycat.apis.localdevice.PermissionManager/RequestAuthToken"
        );
        assert!(!endpoint.as_str().contains("secret"));
    }
}

use axum::body::{Body, Bytes};
use axum::extract::Path;
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE, EXPIRES, PRAGMA};
use axum::http::{HeaderName, HeaderValue, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use tower_http::set_header::SetResponseHeaderLayer;

use crate::embedded_frontend;

pub fn security_header(
    name: HeaderName,
    value: &'static str,
) -> SetResponseHeaderLayer<HeaderValue> {
    SetResponseHeaderLayer::if_not_present(name, HeaderValue::from_static(value))
}

pub async fn index() -> Response {
    match embedded_asset("index.html") {
        Some(asset) => no_store(Html(String::from_utf8_lossy(asset).into_owned()).into_response()),
        None => (
            StatusCode::SERVICE_UNAVAILABLE,
            "frontend assets are not embedded; run npm run build before cargo build",
        )
            .into_response(),
    }
}

fn no_store(mut response: Response) -> Response {
    let headers = response.headers_mut();
    headers.insert(
        CACHE_CONTROL,
        HeaderValue::from_static("no-store, no-cache, must-revalidate, max-age=0"),
    );
    headers.insert(PRAGMA, HeaderValue::from_static("no-cache"));
    headers.insert(EXPIRES, HeaderValue::from_static("0"));
    response
}

pub async fn frontend_asset(Path(path): Path<String>) -> Response {
    let path = format!("assets/{path}");
    let Some(asset) = embedded_asset_response(&path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    asset
}

pub async fn frontend_font(Path(path): Path<String>) -> Response {
    let path = format!("fonts/{path}");
    let Some(asset) = embedded_asset_response(&path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    asset
}

pub async fn frontend_icon() -> Response {
    let Some(asset) = embedded_asset_response("icon.png") else {
        return StatusCode::NOT_FOUND.into_response();
    };
    asset
}

fn embedded_asset(path: &str) -> Option<&'static [u8]> {
    embedded_frontend::FRONTEND_ASSETS
        .iter()
        .find_map(|(asset_path, bytes)| (*asset_path == path).then_some(*bytes))
}

fn embedded_asset_response(path: &str) -> Option<Response> {
    let bytes = embedded_asset(path)?;
    let content_type = mime_guess::from_path(path).first_or_octet_stream();
    let content_type = HeaderValue::from_str(content_type.essence_str()).ok()?;

    let mut response = Response::new(Body::from(Bytes::from_static(bytes)));
    let headers = response.headers_mut();
    headers.insert(CONTENT_TYPE, content_type);
    headers.insert(
        CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=31536000, immutable"),
    );
    Some(response)
}

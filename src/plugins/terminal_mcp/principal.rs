use http::request::Parts;

use super::types::TerminalMcpError;

const MAX_IDENTITY_BYTES: usize = 256;
const MAX_TICKET_BYTES: usize = 8192;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct McpPrincipal {
    pub user_id: String,
    pub caller_app_id: String,
    pub caller_name: String,
}

impl McpPrincipal {
    pub fn from_parts(parts: &Parts) -> Result<Self, TerminalMcpError> {
        require_opaque_header(parts, "x-hc-user-ticket", MAX_TICKET_BYTES)?;
        let user_id = required_header(parts, "x-hc-user-id")?;
        let caller_app_id = required_header(parts, "x-hc-source")?;
        let caller_name =
            optional_header(parts, "x-hc-user-name").unwrap_or_else(|| caller_app_id.clone());
        Ok(Self {
            user_id,
            caller_app_id,
            caller_name,
        })
    }
}

fn require_opaque_header(
    parts: &Parts,
    name: &'static str,
    max_bytes: usize,
) -> Result<(), TerminalMcpError> {
    let valid = parts
        .headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .is_some_and(|value| !value.is_empty() && value.len() <= max_bytes);
    if valid {
        Ok(())
    } else {
        Err(TerminalMcpError::unauthenticated())
    }
}

fn required_header(parts: &Parts, name: &'static str) -> Result<String, TerminalMcpError> {
    optional_header(parts, name).ok_or_else(TerminalMcpError::unauthenticated)
}

fn optional_header(parts: &Parts, name: &'static str) -> Option<String> {
    parts
        .headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= MAX_IDENTITY_BYTES)
        .map(ToOwned::to_owned)
}

#[cfg(test)]
mod tests {
    use http::Request;

    use super::*;

    #[test]
    fn extracts_lazycat_principal_from_request_parts() {
        let (parts, ()) = Request::builder()
            .header("x-hc-user-ticket", "lazycat-ticket")
            .header("x-hc-user-id", " lazycat ")
            .header("x-hc-source", "cloud.lazycat.app.agent")
            .header("x-hc-user-name", "LazyCat")
            .body(())
            .unwrap()
            .into_parts();

        let principal = McpPrincipal::from_parts(&parts).unwrap();

        assert_eq!(principal.user_id, "lazycat");
        assert_eq!(principal.caller_app_id, "cloud.lazycat.app.agent");
        assert_eq!(principal.caller_name, "LazyCat");
    }

    #[test]
    fn rejects_missing_ticket_or_oversized_identity() {
        let (missing, ()) = Request::new(()).into_parts();
        assert_eq!(
            McpPrincipal::from_parts(&missing).unwrap_err().code,
            "UNAUTHENTICATED_CALLER"
        );

        let (projected_without_ticket, ()) = Request::builder()
            .header("x-hc-user-id", "lazycat")
            .header("x-hc-source", "cloud.lazycat.app.agent")
            .body(())
            .unwrap()
            .into_parts();
        assert_eq!(
            McpPrincipal::from_parts(&projected_without_ticket)
                .unwrap_err()
                .code,
            "UNAUTHENTICATED_CALLER"
        );

        let (oversized_identity, ()) = Request::builder()
            .header("x-hc-user-ticket", "lazycat-ticket")
            .header("x-hc-user-id", "u".repeat(MAX_IDENTITY_BYTES + 1))
            .header("x-hc-source", "agent")
            .body(())
            .unwrap()
            .into_parts();
        assert_eq!(
            McpPrincipal::from_parts(&oversized_identity)
                .unwrap_err()
                .code,
            "UNAUTHENTICATED_CALLER"
        );

        let (oversized_ticket, ()) = Request::builder()
            .header("x-hc-user-ticket", "t".repeat(MAX_TICKET_BYTES + 1))
            .header("x-hc-user-id", "lazycat")
            .header("x-hc-source", "agent")
            .body(())
            .unwrap()
            .into_parts();
        assert_eq!(
            McpPrincipal::from_parts(&oversized_ticket)
                .unwrap_err()
                .code,
            "UNAUTHENTICATED_CALLER"
        );
    }
}

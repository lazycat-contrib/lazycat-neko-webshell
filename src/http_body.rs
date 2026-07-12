use futures::StreamExt as _;

pub(crate) async fn read_limited_body(
    response: reqwest::Response,
    max_bytes: usize,
    label: &str,
) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err(format!("{label} is too large"));
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| error.to_string())?;
        append_limited(&mut body, &chunk, max_bytes, label)?;
    }
    Ok(body)
}

fn append_limited(
    body: &mut Vec<u8>,
    chunk: &[u8],
    max_bytes: usize,
    label: &str,
) -> Result<(), String> {
    if chunk.len() > max_bytes.saturating_sub(body.len()) {
        return Err(format!("{label} is too large"));
    }
    body.extend_from_slice(chunk);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::append_limited;

    #[test]
    fn rejects_a_chunk_before_exceeding_the_body_limit() {
        let mut body = b"1234".to_vec();

        let error =
            append_limited(&mut body, b"56", 5, "response").expect_err("body must stay bounded");

        assert_eq!(error, "response is too large");
        assert_eq!(body, b"1234");
    }
}

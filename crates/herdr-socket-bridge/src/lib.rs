use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::Shutdown;
use std::os::unix::fs::FileTypeExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::thread;

pub const MAX_REQUEST_BYTES: usize = 1024 * 1024;
pub const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_GRAPHICS_STREAM_HEADER_BYTES: usize = 64 * 1024;
pub const MAX_GRAPHICS_STREAM_FRAME_BYTES: usize = 16 * 1024 * 1024;

pub struct SocketSearch<'a> {
    pub explicit: Option<&'a Path>,
    pub login_user: &'a str,
}

pub fn find_herdr_socket(search: SocketSearch<'_>) -> io::Result<PathBuf> {
    if let Some(explicit) = search.explicit {
        return require_unix_socket(explicit);
    }
    if let Some(path) = std::env::var_os("HERDR_SOCKET_PATH")
        .map(PathBuf::from)
        .filter(|path| is_unix_socket(path))
    {
        return Ok(path);
    }

    let home = login_home(search.login_user)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("/root"));
    let mut homes = vec![home];
    let root = PathBuf::from("/root");
    if homes[0] != root {
        homes.push(root);
    }

    for home in &homes {
        let socket = home.join(".config/herdr/herdr.sock");
        if is_unix_socket(&socket) {
            return Ok(socket);
        }
    }
    for home in homes {
        let sessions = home.join(".config/herdr/sessions");
        let mut sockets = std::fs::read_dir(sessions)
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .map(|entry| entry.path().join("herdr.sock"))
            .filter(|path| is_unix_socket(path))
            .collect::<Vec<_>>();
        sockets.sort();
        if let Some(socket) = sockets.into_iter().next() {
            return Ok(socket);
        }
    }

    Err(io::Error::new(
        io::ErrorKind::NotFound,
        "Herdr socket was not found",
    ))
}

pub fn bridge_stdio(socket_path: &Path) -> io::Result<()> {
    let stream = UnixStream::connect(socket_path)?;
    bridge_with_io(stream, io::stdin(), io::stdout())
}

pub fn request_stdio(socket_path: &Path) -> io::Result<()> {
    let stream = UnixStream::connect(socket_path)?;
    request_with_io(
        stream,
        io::stdin().lock(),
        io::stdout(),
        MAX_REQUEST_BYTES,
        MAX_RESPONSE_BYTES,
    )
}

fn bridge_with_io<R, W>(mut stream: UnixStream, mut input: R, mut output: W) -> io::Result<()>
where
    R: Read + Send + 'static,
    W: Write,
{
    let socket_reader = stream.try_clone()?;
    let input_thread = thread::spawn(move || {
        let result = io::copy(&mut input, &mut stream).map(|_| ());
        // Keep the read half alive for Herdr's final frame acknowledgement.
        stream.shutdown(Shutdown::Write).ok();
        result
    });

    let output_result = copy_lines_limited(socket_reader, &mut output, MAX_RESPONSE_BYTES);
    if input_thread.is_finished() {
        input_thread
            .join()
            .map_err(|_| io::Error::other("Herdr socket input bridge panicked"))??;
    }
    output_result
}

fn request_with_io<R, W>(
    mut stream: UnixStream,
    input: R,
    mut output: W,
    request_limit: usize,
    response_limit: usize,
) -> io::Result<()>
where
    R: Read,
    W: Write,
{
    let mut request = Vec::new();
    require_line_limited(
        &mut BufReader::new(input),
        &mut request,
        request_limit,
        "Herdr request",
    )?;
    stream.write_all(&request)?;
    stream.flush()?;

    let mut response = Vec::new();
    require_line_limited(
        &mut BufReader::new(stream),
        &mut response,
        response_limit,
        "Herdr response",
    )?;
    output.write_all(&response)?;
    output.flush()
}

fn copy_lines_limited<R, W>(reader: R, output: &mut W, limit: usize) -> io::Result<()>
where
    R: Read,
    W: Write,
{
    let mut reader = BufReader::new(reader);
    let mut line = Vec::new();
    loop {
        line.clear();
        if !read_line_limited(&mut reader, &mut line, limit, "Herdr stream message")? {
            return output.flush();
        }
        output.write_all(&line)?;
        output.flush()?;
    }
}

fn require_line_limited<R: BufRead>(
    reader: &mut R,
    output: &mut Vec<u8>,
    limit: usize,
    label: &str,
) -> io::Result<()> {
    if read_line_limited(reader, output, limit, label)? {
        return Ok(());
    }
    Err(io::Error::new(
        io::ErrorKind::UnexpectedEof,
        format!("{label} ended before a newline"),
    ))
}

fn read_line_limited<R: BufRead>(
    reader: &mut R,
    output: &mut Vec<u8>,
    limit: usize,
    label: &str,
) -> io::Result<bool> {
    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            if output.is_empty() {
                return Ok(false);
            }
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                format!("{label} ended before a newline"),
            ));
        }
        let consumed = buffer
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(buffer.len(), |index| index + 1);
        if output.len().saturating_add(consumed) > limit {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("{label} exceeds {limit} bytes"),
            ));
        }
        let complete = buffer[consumed - 1] == b'\n';
        output.extend_from_slice(&buffer[..consumed]);
        reader.consume(consumed);
        if complete {
            return Ok(true);
        }
    }
}

fn require_unix_socket(path: &Path) -> io::Result<PathBuf> {
    if is_unix_socket(path) {
        return Ok(path.to_owned());
    }
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        format!("Herdr socket does not exist: {}", path.display()),
    ))
}

fn is_unix_socket(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|metadata| metadata.file_type().is_socket())
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LoginIdentity {
    pub home: PathBuf,
    pub uid: u32,
    pub gid: u32,
}

pub fn login_identity(login_user: &str) -> Option<LoginIdentity> {
    let login_user = login_user.trim();
    if login_user.is_empty() {
        return None;
    }
    for getent in ["/usr/bin/getent", "/bin/getent"] {
        if !Path::new(getent).is_file() {
            continue;
        }
        if let Some(home) = std::process::Command::new(getent)
            .args(["passwd", login_user])
            .output()
            .ok()
            .filter(|output| output.status.success())
            .and_then(|output| {
                passwd_identity(&String::from_utf8_lossy(&output.stdout), login_user)
            })
        {
            return Some(home);
        }
    }
    passwd_identity(&std::fs::read_to_string("/etc/passwd").ok()?, login_user)
}

pub fn login_home(login_user: &str) -> Option<PathBuf> {
    login_identity(login_user).map(|identity| identity.home)
}

fn passwd_identity(passwd: &str, login_user: &str) -> Option<LoginIdentity> {
    passwd
        .lines()
        .filter_map(|line| {
            let mut fields = line.split(':');
            let username = fields.next()?;
            let _password = fields.next()?;
            let uid = fields.next()?.parse().ok()?;
            let gid = fields.next()?.parse().ok()?;
            let _gecos = fields.next()?;
            let home = fields.next()?;
            (username == login_user && !home.is_empty()).then(|| LoginIdentity {
                home: PathBuf::from(home),
                uid,
                gid,
            })
        })
        .next()
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead, BufReader, Cursor, Read, Write};
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::sync::{Arc, Mutex, mpsc};
    use std::thread;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use super::{
        LoginIdentity, SocketSearch, bridge_with_io, copy_lines_limited, find_herdr_socket,
        passwd_identity, request_with_io,
    };

    #[derive(Clone, Default)]
    struct SharedWriter(Arc<Mutex<Vec<u8>>>);

    impl Write for SharedWriter {
        fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
            self.0
                .lock()
                .expect("lock output")
                .extend_from_slice(buffer);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    struct HeldOpenReader {
        initial: Cursor<Vec<u8>>,
        release: mpsc::Receiver<()>,
    }

    #[test]
    fn parses_login_identity_from_passwd() {
        assert_eq!(
            passwd_identity(
                "root:x:0:0:root:/root:/bin/sh\nalice:x:1000:1001:Alice:/home/alice:/bin/bash\n",
                "alice",
            ),
            Some(LoginIdentity {
                home: "/home/alice".into(),
                uid: 1000,
                gid: 1001,
            })
        );
        assert_eq!(
            passwd_identity("broken:x:not-a-uid:2::/tmp:/bin/sh\n", "broken"),
            None
        );
    }

    impl Read for HeldOpenReader {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            let read = self.initial.read(buffer)?;
            if read > 0 {
                return Ok(read);
            }
            let _ = self.release.recv();
            Ok(0)
        }
    }

    #[test]
    fn bridge_forwards_multiple_requests_and_events() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after the Unix epoch")
            .as_nanos();
        let socket_path = std::env::temp_dir().join(format!(
            "neko-herdr-bridge-{}-{nonce}.sock",
            std::process::id()
        ));
        let listener = UnixListener::bind(&socket_path).expect("bind fake Herdr socket");
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept bridge connection");
            let mut reader = BufReader::new(socket.try_clone().expect("clone fake Herdr socket"));
            let mut requests = Vec::new();
            for response in ["first", "second"] {
                let mut request = String::new();
                reader
                    .read_line(&mut request)
                    .expect("read bridged request");
                requests.push(request);
                writeln!(socket, "{{\"event\":\"{response}\"}}").ok();
            }
            requests
        });

        let stream = UnixStream::connect(&socket_path).expect("connect fake Herdr socket");
        let output = SharedWriter::default();
        let captured = Arc::clone(&output.0);
        let (release, held_open) = mpsc::channel();
        let result = bridge_with_io(
            stream,
            HeldOpenReader {
                initial: Cursor::new(b"{\"id\":\"one\"}\n{\"id\":\"two\"}\n".to_vec()),
                release: held_open,
            },
            output,
        );
        drop(release);
        let requests = server.join().expect("join fake Herdr server");
        std::fs::remove_file(&socket_path).ok();

        result.expect("bridge requests and events");
        assert_eq!(requests, ["{\"id\":\"one\"}\n", "{\"id\":\"two\"}\n"]);
        assert_eq!(
            *captured.lock().expect("lock captured output"),
            b"{\"event\":\"first\"}\n{\"event\":\"second\"}\n"
        );
    }

    #[test]
    fn stream_bridge_forwards_graphics_frame_bytes_verbatim() {
        let (client, mut server) = UnixStream::pair().expect("create socket pair");
        let header = br#"{"format":"png","image_width":2,"image_height":1,"data_length":4}"#;
        let body = [0_u8, 0xff, b'\n', 0x80];
        let mut input = Vec::from(header.as_slice());
        input.push(b'\n');
        input.extend_from_slice(&body);
        let output = SharedWriter::default();
        let captured = Arc::clone(&output.0);

        let server = thread::spawn(move || {
            let mut reader = BufReader::new(server.try_clone().expect("clone fake Herdr socket"));
            let mut received_header = String::new();
            reader
                .read_line(&mut received_header)
                .expect("read graphics frame header");
            let mut received_body = [0_u8; 4];
            reader
                .read_exact(&mut received_body)
                .expect("read graphics frame body");
            writeln!(server, r#"{{"result":{{"type":"ok"}}}}"#)
                .expect("write frame acknowledgement");
            (received_header, received_body)
        });

        bridge_with_io(client, Cursor::new(input), output).expect("bridge graphics frame");
        let (received_header, received_body) = server.join().expect("join fake Herdr server");

        assert_eq!(
            received_header.as_bytes(),
            [header.as_slice(), b"\n"].concat()
        );
        assert_eq!(received_body, body);
        assert_eq!(
            *captured.lock().expect("lock captured output"),
            b"{\"result\":{\"type\":\"ok\"}}\n"
        );
    }

    #[test]
    fn stream_bridge_returns_when_herdr_closes_while_input_is_open() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after the Unix epoch")
            .as_nanos();
        let socket_path = std::env::temp_dir().join(format!(
            "neko-herdr-disconnect-{}-{nonce}.sock",
            std::process::id()
        ));
        let listener = UnixListener::bind(&socket_path).expect("bind fake Herdr socket");
        let server = thread::spawn(move || {
            let (socket, _) = listener.accept().expect("accept bridge connection");
            drop(socket);
        });
        let stream = UnixStream::connect(&socket_path).expect("connect fake Herdr socket");
        let (release, held_open) = mpsc::channel();
        let (finished_tx, finished_rx) = mpsc::channel();
        let bridge = thread::spawn(move || {
            let bridge_result = bridge_with_io(
                stream,
                HeldOpenReader {
                    initial: Cursor::new(Vec::new()),
                    release: held_open,
                },
                SharedWriter::default(),
            );
            finished_tx.send(bridge_result).ok();
        });

        let bridge_result = finished_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("bridge should observe Herdr disconnect");
        drop(release);
        bridge.join().expect("join bridge thread");
        server.join().expect("join fake Herdr server");
        std::fs::remove_file(&socket_path).ok();
        bridge_result.expect("bridge Herdr disconnect");
    }

    #[test]
    fn request_bridge_keeps_write_half_open_until_response() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after the Unix epoch")
            .as_nanos();
        let socket_path = std::env::temp_dir().join(format!(
            "neko-herdr-request-{}-{nonce}.sock",
            std::process::id()
        ));
        let listener = UnixListener::bind(&socket_path).expect("bind fake Herdr socket");
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("accept bridge connection");
            let mut request = String::new();
            BufReader::new(socket.try_clone().expect("clone fake Herdr socket"))
                .read_line(&mut request)
                .expect("read bridged request");
            socket
                .set_read_timeout(Some(Duration::from_millis(50)))
                .expect("set socket timeout");
            let mut probe = [0_u8; 1];
            let probe_result = socket.read(&mut probe);
            assert!(
                probe_result.is_err_and(|error| matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                )),
                "request bridge must not half-close before the response"
            );
            writeln!(socket, "{{\"id\":\"one\",\"result\":{{}}}}").expect("write response");
            request
        });

        let stream = UnixStream::connect(&socket_path).expect("connect fake Herdr socket");
        let output = SharedWriter::default();
        let captured = Arc::clone(&output.0);
        request_with_io(
            stream,
            Cursor::new(b"{\"id\":\"one\"}\n".to_vec()),
            output,
            1024,
            1024,
        )
        .expect("bridge one request");
        let request = server.join().expect("join fake Herdr server");
        std::fs::remove_file(&socket_path).ok();

        assert_eq!(request, "{\"id\":\"one\"}\n");
        assert_eq!(
            *captured.lock().expect("lock captured output"),
            b"{\"id\":\"one\",\"result\":{}}\n"
        );
    }

    #[test]
    fn request_bridge_rejects_oversized_responses() {
        let (client, mut server) = UnixStream::pair().expect("create socket pair");
        let server = thread::spawn(move || {
            let mut request = String::new();
            BufReader::new(server.try_clone().expect("clone fake Herdr socket"))
                .read_line(&mut request)
                .expect("read bridged request");
            writeln!(server, "12345").expect("write oversized response");
        });

        let error = request_with_io(
            client,
            Cursor::new(b"request\n".to_vec()),
            SharedWriter::default(),
            16,
            4,
        )
        .expect_err("reject oversized response");
        server.join().expect("join fake Herdr server");
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    }

    #[test]
    fn stream_bridge_rejects_oversized_messages() {
        let mut output = SharedWriter::default();
        let error = copy_lines_limited(Cursor::new(b"12345\n"), &mut output, 4)
            .expect_err("reject oversized stream message");
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    }

    #[test]
    fn socket_search_accepts_an_explicit_unix_socket() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after the Unix epoch")
            .as_nanos();
        let socket_path = std::env::temp_dir().join(format!(
            "neko-herdr-search-{}-{nonce}.sock",
            std::process::id()
        ));
        let listener = UnixListener::bind(&socket_path).expect("bind explicit Herdr socket");

        let resolved = find_herdr_socket(SocketSearch {
            explicit: Some(&socket_path),
            login_user: "ignored",
        })
        .expect("resolve explicit Herdr socket");

        drop(listener);
        std::fs::remove_file(&socket_path).ok();
        assert_eq!(resolved, socket_path);
    }
}

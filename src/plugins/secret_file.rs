//! Private clipboard files: contents travel only over stdin, never a PTY or argv.
use std::process::Stdio;
use std::time::Duration;

use connectrpc::ConnectError;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

pub const MAX_SECRET_BYTES: usize = 1024 * 1024;
const PREFIX: &str = "/tmp/lazycat-webshell-secret-";

pub fn validate_payload(payload: &[u8]) -> Result<(), ConnectError> {
    if payload.is_empty()
        || payload.len() > MAX_SECRET_BYTES
        || std::str::from_utf8(payload).is_err()
    {
        return Err(ConnectError::invalid_argument(
            "secret must be UTF-8 text between 1 byte and 1 MiB",
        ));
    }
    Ok(())
}

pub fn new_path() -> String {
    format!(
        "{PREFIX}{}/key-{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

pub fn valid_path(path: &str) -> bool {
    let Some(suffix) = path.strip_prefix(PREFIX) else {
        return false;
    };
    let Some((directory, file)) = suffix.split_once("/key-") else {
        return false;
    };
    [directory, file].iter().all(|part| {
        part.len() == 32
            && part
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

pub fn create_script(path: &str, size: usize) -> Result<String, ConnectError> {
    if !valid_path(path) || size == 0 || size > MAX_SECRET_BYTES {
        return Err(ConnectError::invalid_argument(
            "invalid secret file request",
        ));
    }
    Ok(format!(
        r#"set -efu
PATH=/usr/bin:/bin
export PATH
umask 077
ulimit -f 2048
path='{path}'
dir="${{path%/*}}"
mkdir -m 700 -- "$dir" || exit 1
cleanup() {{ rm -f -- "$path"; rmdir -- "$dir"; }}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
set -C
cat > "$path"
[ "$(wc -c < "$path" | tr -d ' ')" = '{size}' ]
chmod 600 -- "$path"
trap - EXIT HUP INT TERM
"#
    ))
}

pub fn delete_script(path: &str) -> Result<String, ConnectError> {
    if !valid_path(path) {
        return Err(ConnectError::invalid_argument("invalid secret file path"));
    }
    Ok(format!(
        r#"set -efu
PATH=/usr/bin:/bin
export PATH
path='{path}'
dir="${{path%/*}}"
[ ! -L "$dir" ] && [ ! -L "$path" ]
[ -d "$dir" ] && [ -f "$path" ]
[ "$(stat -c '%u:%a' -- "$dir")" = "$(id -u):700" ]
[ "$(stat -c '%u:%a' -- "$path")" = "$(id -u):600" ]
rm -- "$path"
rmdir -- "$dir"
"#
    ))
}

/// Never fall back to root when a target's login identity cannot be entered.
/// Secret-file commands need no login-shell setup and run with a clean environment.
pub fn script_as_user(login_user: &str, script: &str) -> String {
    let user = if login_user.trim().is_empty() {
        "root"
    } else {
        login_user.trim()
    };
    let quote = |value: &str| format!("'{}'", value.replace('\'', "'\"'\"'"));
    let user = quote(user);
    let checked = quote(&format!(
        "set -eu\n[ \"$(id -u)\" = \"$(id -u {user})\" ]\n[ \"$(id -g)\" = \"$(id -g {user})\" ]\n{script}"
    ));
    let clean = quote(&format!(
        "exec env -i PATH=/usr/bin:/bin /bin/sh -c {checked}"
    ));
    format!(
        r#"set -eu
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
user={user}
uid="$(id -u "$user")"
gid="$(id -g "$user")"
if [ "$(id -u):$(id -g)" = "$uid:$gid" ]; then
  exec env -i PATH=/usr/bin:/bin /bin/sh -c {checked}
fi
if command -v setpriv >/dev/null 2>&1; then
  exec setpriv --reuid "$uid" --regid "$gid" --init-groups env -i PATH=/usr/bin:/bin /bin/sh -c {checked}
fi
if command -v su >/dev/null 2>&1; then
  exec su -s /bin/sh "$user" -c {clean}
fi
exit 127
"#
    )
}

/// Bounds include stdin writes and both output streams. Dropping a timed-out
/// command kills the local transport; script traps clean up incomplete writes.
pub async fn run(mut command: Command, payload: &[u8]) -> Result<Vec<u8>, ConnectError> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|_| failure())?;
    let mut stdin = child.stdin.take().ok_or_else(failure)?;
    let stdout = child.stdout.take().ok_or_else(failure)?;
    let stderr = child.stderr.take().ok_or_else(failure)?;
    let operation = async {
        let input = async {
            stdin.write_all(payload).await?;
            stdin.shutdown().await?;
            drop(stdin);
            Ok::<_, std::io::Error>(())
        };
        let output = async {
            let mut bytes = Vec::new();
            stdout.take(1025).read_to_end(&mut bytes).await?;
            if bytes.len() > 1024 {
                return Err(std::io::Error::other("output limit"));
            }
            Ok(bytes)
        };
        let errors = async {
            let mut bytes = Vec::new();
            stderr.take(4097).read_to_end(&mut bytes).await?;
            if bytes.len() > 4096 {
                return Err(std::io::Error::other("output limit"));
            }
            Ok(())
        };
        let (_, bytes, (), status) = tokio::try_join!(input, output, errors, child.wait())?;
        if !status.success() {
            return Err(std::io::Error::other("command failed"));
        }
        Ok::<_, std::io::Error>(bytes)
    };
    tokio::time::timeout(Duration::from_secs(20), operation)
        .await
        .map_err(|_| failure())?
        .map_err(|_| failure())
}

fn failure() -> ConnectError {
    // Never surface subprocess output: a remote command could echo stdin.
    ConnectError::failed_precondition("secret file operation failed")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn shell(script: &str) -> Command {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", script]);
        command
    }

    #[tokio::test]
    async fn secret_file_preserves_bytes_and_permissions_and_deletes() {
        let path = new_path();
        let payload = b"  PRIVATE TEST DATA\nline two\n\n";
        let result = run(
            shell(&create_script(&path, payload.len()).unwrap()),
            payload,
        )
        .await
        .unwrap();
        assert!(result.is_empty());
        assert_eq!(std::fs::read(&path).unwrap(), payload);
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let parent = std::path::Path::new(&path).parent().unwrap();
        assert_eq!(
            std::fs::metadata(parent).unwrap().permissions().mode() & 0o777,
            0o700
        );
        run(shell(&delete_script(&path).unwrap()), &[])
            .await
            .unwrap();
        assert!(!parent.exists());
    }

    #[tokio::test]
    async fn secret_file_rejects_existing_directory_and_cleans_short_write() {
        let path = new_path();
        let script = create_script(&path, 4).unwrap();
        assert!(run(shell(&script), b"abc").await.is_err());
        let parent = std::path::Path::new(&path).parent().unwrap();
        assert!(!parent.exists());
        std::fs::create_dir(parent).unwrap();
        assert!(run(shell(&script), b"abcd").await.is_err());
        assert!(parent.exists()); // Do not clean up a directory we did not create.
        std::fs::remove_dir(parent).unwrap();
    }

    #[tokio::test]
    async fn secret_file_refuses_symlinks() {
        let path = new_path();
        run(shell(&create_script(&path, 1).unwrap()), b"x")
            .await
            .unwrap();
        std::fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink("/dev/null", &path).unwrap();
        assert!(
            run(shell(&delete_script(&path).unwrap()), &[])
                .await
                .is_err()
        );
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(std::path::Path::new(&path).parent().unwrap()).unwrap();
    }

    #[tokio::test]
    async fn secret_file_output_is_bounded_and_redacted() {
        assert!(run(shell("yes confidential"), &[]).await.is_err());
        assert!(
            run(shell("cat >&2; exit 1"), b"confidential")
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn secret_file_user_switch_is_checked_and_environment_is_clean() {
        let output = std::process::Command::new("id")
            .arg("-un")
            .output()
            .unwrap();
        let user = String::from_utf8(output.stdout).unwrap();
        let script = script_as_user(user.trim(), "printf '%s' \"${SECRET_TEST_ENV-unset}\"");
        let mut command = shell(&script);
        command.env("SECRET_TEST_ENV", "must-not-pass");
        assert_eq!(run(command, &[]).await.unwrap(), b"unset");
        assert!(
            run(
                shell(&script_as_user(
                    "webshell-user-that-does-not-exist",
                    "printf bad"
                )),
                &[]
            )
            .await
            .is_err()
        );
        assert!(script.ends_with("exit 127\n"));
    }

    #[test]
    fn secret_file_validates_input_and_path() {
        for input in [&b""[..], &[0xff][..], &vec![b'x'; MAX_SECRET_BYTES + 1][..]] {
            assert!(validate_payload(input).is_err());
        }
        assert!(validate_payload(b"\n ").is_ok());
        let path = new_path();
        assert!(valid_path(&path));
        assert_ne!(path, new_path());
        for invalid in [
            "/tmp/key",
            &(path.clone() + "/../victim"),
            &(path.clone() + "'"),
            "/etc/passwd",
        ] {
            assert!(!valid_path(invalid));
            assert!(delete_script(invalid).is_err());
        }
    }
}

use std::env;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    connectrpc_build::Config::new()
        .files(&[
            "proto/lazycat/webshell/v1/capability.proto",
            "proto/cloud/lazycat/apis/localdevice/permission.proto",
        ])
        .includes(&["proto/"])
        .include_file("_connectrpc.rs")
        .compile()
        .expect("connectrpc code generation failed");

    embed_frontend_assets().expect("frontend asset embedding failed");
    embed_webshell_agent().expect("webshell agent embedding failed");
}

fn embed_webshell_agent() -> std::io::Result<()> {
    const ENV_NAME: &str = "NEKO_WEBSHELL_AGENT_BINARY";
    const AGENT_ONLY_ENV_NAME: &str = "NEKO_WEBSHELL_BUILD_AGENT_ONLY";
    const MAX_AGENT_BINARY_BYTES: u64 = 16 * 1024 * 1024;
    println!("cargo:rerun-if-env-changed={ENV_NAME}");
    println!("cargo:rerun-if-env-changed={AGENT_ONLY_ENV_NAME}");
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("missing OUT_DIR"));
    let generated = if let Some(path) = env::var_os(ENV_NAME).filter(|value| !value.is_empty()) {
        let path = PathBuf::from(path);
        let metadata = fs::metadata(&path)?;
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_AGENT_BINARY_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "embedded agent payload must be a non-empty file no larger than {MAX_AGENT_BINARY_BYTES} bytes: {}",
                    path.display()
                ),
            ));
        }
        println!("cargo:rerun-if-changed={}", path.display());
        format!(
            "pub static EMBEDDED_AGENT_BINARY: &[u8] = include_bytes!({:?});\n",
            path.display().to_string()
        )
    } else if env::var("PROFILE").as_deref() == Ok("release")
        && env::var(AGENT_ONLY_ENV_NAME).as_deref() != Ok("1")
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "release provider builds require NEKO_WEBSHELL_AGENT_BINARY; use scripts/build-release.sh",
        ));
    } else {
        "pub static EMBEDDED_AGENT_BINARY: &[u8] = &[];\n".to_owned()
    };
    fs::write(out_dir.join("embedded_agent.rs"), generated)
}

fn embed_frontend_assets() -> std::io::Result<()> {
    let manifest_dir =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("missing manifest dir"));
    let frontend_dist = manifest_dir.join("src/frontend/dist");
    println!("cargo:rerun-if-changed={}", frontend_dist.display());

    let mut files = Vec::new();
    if frontend_dist.exists() {
        collect_files(&frontend_dist, &frontend_dist, &mut files)?;
    }
    files.sort_by(|left, right| left.0.cmp(&right.0));

    let mut generated = String::from("pub static FRONTEND_ASSETS: &[(&str, &[u8])] = &[\n");
    for (asset_path, file_path) in files {
        writeln!(
            &mut generated,
            "    ({asset_path:?}, include_bytes!({:?}).as_slice()),",
            file_path.display().to_string()
        )
        .expect("writing to String cannot fail");
    }
    generated.push_str("];\n");

    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("missing OUT_DIR"));
    fs::write(out_dir.join("frontend_assets.rs"), generated)
}

fn collect_files(
    root: &Path,
    directory: &Path,
    files: &mut Vec<(String, PathBuf)>,
) -> std::io::Result<()> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_files(root, &path, files)?;
            continue;
        }
        if path.is_file() {
            let relative = path.strip_prefix(root).expect("asset must be under root");
            let asset_path = relative.to_string_lossy().replace('\\', "/");
            files.push((asset_path, path));
        }
    }
    Ok(())
}

use std::env;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    connectrpc_build::Config::new()
        .files(&["proto/lazycat/webshell/v1/capability.proto"])
        .includes(&["proto/"])
        .include_file("_connectrpc.rs")
        .compile()
        .expect("connectrpc code generation failed");

    embed_frontend_assets().expect("frontend asset embedding failed");
    embed_webshell_agent().expect("webshell agent embedding failed");
}

fn embed_webshell_agent() -> std::io::Result<()> {
    const ENV_NAME: &str = "NEKO_WEBSHELL_AGENT_BINARY";
    println!("cargo:rerun-if-env-changed={ENV_NAME}");
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("missing OUT_DIR"));
    let generated = if let Some(path) = env::var_os(ENV_NAME).filter(|value| !value.is_empty()) {
        let path = PathBuf::from(path);
        println!("cargo:rerun-if-changed={}", path.display());
        format!(
            "pub static EMBEDDED_AGENT_BINARY: &[u8] = include_bytes!({:?});\n",
            path.display().to_string()
        )
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

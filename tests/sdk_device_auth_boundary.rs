use std::fs;
use std::path::{Path, PathBuf};

#[test]
fn device_authentication_is_owned_by_the_shared_rust_sdk() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let manifest = read(root.join("Cargo.toml"));
    assert!(
        manifest.contains("lzc-sdk = {")
            && manifest.contains("version = \"0.1.1\"")
            && manifest.contains("features = [\"gateway\"]"),
        "Neko must consume the crates.io release of the shared Rust SDK"
    );

    let sdk_dependency = manifest
        .split("lzc-sdk = {")
        .nth(1)
        .and_then(|value| value.split('}').next())
        .expect("lzc-sdk dependency table");
    assert!(
        !sdk_dependency.contains("path =") && !sdk_dependency.contains("git ="),
        "the SDK dependency must come from crates.io rather than a local path or Git"
    );

    assert!(
        !root.join("src/device_api_auth.rs").exists(),
        "device authentication must not be reimplemented inside Neko"
    );
    assert!(
        !root
            .join("proto/cloud/lazycat/apis/localdevice/permission.proto")
            .exists(),
        "the device-auth protobuf belongs in lzc-sdk, not Neko"
    );

    let build_script = read(root.join("build.rs"));
    assert!(
        !build_script.contains("permission.proto"),
        "Neko must not generate the SDK-owned device-auth protobuf"
    );

    let source = read_source_tree(&root.join("src"));
    for forbidden in [
        "RequestAuthToken",
        "encode_grpc_request",
        "http2_prior_knowledge",
        "sign_subject_serial",
        "mod device_api_auth",
    ] {
        assert!(
            !source.contains(forbidden),
            "Neko source must not contain SDK-owned device-auth primitive {forbidden:?}"
        );
    }
}

fn read(path: impl AsRef<Path>) -> String {
    fs::read_to_string(path.as_ref())
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.as_ref().display()))
}

fn read_source_tree(root: &Path) -> String {
    let mut paths = Vec::new();
    collect_source_files(root, &mut paths);
    paths.sort();
    paths.into_iter().map(read).collect::<Vec<_>>().join("\n")
}

fn collect_source_files(directory: &Path, paths: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(directory)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", directory.display()))
    {
        let path = entry.expect("directory entry").path();
        if path.is_dir() {
            collect_source_files(&path, paths);
        } else if path
            .extension()
            .is_some_and(|extension| matches!(extension.to_str(), Some("rs" | "ts")))
        {
            paths.push(path);
        }
    }
}

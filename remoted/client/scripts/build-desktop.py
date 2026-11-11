#!/usr/bin/env python3
"""Build native desktop packages without changing Android's application version."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import re
import shutil
import subprocess
import tempfile
import tomllib
import zipfile

CLIENT = Path(__file__).resolve().parents[1]
NSH_REV = "0e4a20bd41ee72a35515cecbf9a7fba88742d911"
APP_ID = "community.lazycat.neko.remoted"
BINARY = "neko-remoted-client"


def run(*args, **kwargs):
    return subprocess.run([str(arg) for arg in args], check=True, **kwargs)


def output(*args):
    return subprocess.check_output([str(arg) for arg in args], text=True).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True, help="Independent desktop version, e.g. 0.2.0")
    parser.add_argument("--target", required=True, choices=["x86_64-unknown-linux-gnu", "x86_64-pc-windows-msvc", "aarch64-apple-darwin", "x86_64-apple-darwin"])
    parser.add_argument("--out", type=Path, default=CLIENT / "target/desktop-dist")
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", args.version):
        parser.error("--version must be a three-part numeric desktop version")
    system = {"Linux": "linux", "Darwin": "macos", "Windows": "windows"}.get(platform.system())
    if system is None or not {"linux": "linux", "macos": "darwin", "windows": "windows"}[system] in args.target:
        parser.error("Build on the target OS; macOS supports either CPU target with Xcode")
    cargo_target = Path(os.environ.get("CARGO_TARGET_DIR", CLIENT / "target")).resolve()
    args.out = args.out.resolve()
    args.out.mkdir(parents=True, exist_ok=True)
    source_sha = output("git", "-C", CLIENT, "rev-parse", "HEAD")
    source_dirty = bool(output("git", "-C", CLIENT, "status", "--porcelain", "--", ".", "../protocol"))
    run("cargo", "build", "--manifest-path", CLIENT / "Cargo.toml", "--locked", "--release", "--target", args.target, "--bin", BINARY)
    binary = cargo_target / args.target / "release" / (BINARY + (".exe" if system == "windows" else ""))
    info = {"desktop_version": args.version, "crate_version": tomllib.loads((CLIENT / "Cargo.toml").read_text())["package"]["version"], "target": args.target,
            "source_sha": source_sha, "source_dirty": source_dirty, "nsh_revision": NSH_REV,
            "signing": "ad-hoc; not notarized" if system == "macos" else "unsigned",
            "cargo_binary_sha256": hashlib.sha256(binary.read_bytes()).hexdigest()}
    # Check the locked dependency, rather than trusting a toolchain checkout.
    if f"{NSH_REV}" not in (CLIENT / "Cargo.lock").read_text():
        raise RuntimeError("Cargo.lock does not contain the pinned NSH revision")
    stem = f"neko-remoted-desktop-{args.version}-{args.target}"
    with tempfile.TemporaryDirectory(prefix="remoted-desktop-") as work:
        stage = Path(work)
        licenses = stage / "licenses"
        licenses.mkdir()
        shutil.copy2(CLIENT.parent / "LICENSE", licenses / "NEKO-LICENSE")
        shutil.copy2(CLIENT / "android/licenses/NSH-LICENSE-APACHE", licenses / "NSH-LICENSE-APACHE")
        (stage / "INSTALL.txt").write_text(
            "Remoted desktop " + args.version + "\nEnter the same HTTPS/WSS Relay as the host, then paste/type its device code.\n"
            "The host must explicitly approve the device. No camera is required.\n"
            "Credentials stay in the OS credential store. Never delete them to repair a temporary store failure.\n"
            "Windows: extract ZIP, run neko-remoted-client.exe; unsigned, SmartScreen may warn.\n"
            "macOS: extract ZIP, copy Remoted.app to Applications; ad-hoc signed, NOT notarized.\n"
            "Use System Settings > Privacy & Security > Open Anyway for a trusted local build if Gatekeeper blocks it.\n"
            "Linux: install deb with apt; a running and unlocked Secret Service (e.g. GNOME Keyring) is required.\n",
            encoding="utf-8")
        if system == "linux":
            # Match this build host, including local non-Ubuntu validation builds.
            glibc = output("getconf", "GNU_LIBC_VERSION").split()[-1]
            gtk = output("pkg-config", "--modversion", "gtk4")
            glib = output("pkg-config", "--modversion", "glib-2.0")
            gst = output("pkg-config", "--modversion", "gstreamer-1.0")
            info["build_runtime_versions"] = {"libc6": glibc, "gtk4": gtk, "glib": glib, "gstreamer": gst}
            root = stage / "deb"
            bindir = root / "usr/bin"
            bindir.mkdir(parents=True)
            shutil.copy2(binary, bindir / BINARY)
            (bindir / BINARY).chmod(0o755)
            docs = root / "usr/share/doc/neko-remoted-desktop"
            docs.mkdir(parents=True)
            shutil.copytree(licenses, docs / "licenses")
            shutil.copy2(stage / "INSTALL.txt", docs / "INSTALL.txt")
            desktop = root / f"usr/share/applications/{APP_ID}.desktop"
            desktop.parent.mkdir(parents=True)
            desktop.write_text(f"[Desktop Entry]\nType=Application\nName=Remoted\nName[zh_CN]=小橘远程\nExec={BINARY}\nIcon={APP_ID}\nTerminal=false\nCategories=Network;RemoteAccess;\nStartupWMClass={APP_ID}\n", encoding="utf-8")
            icon = root / f"usr/share/pixmaps/{APP_ID}.png"
            icon.parent.mkdir(parents=True)
            shutil.copy2(CLIENT / "android/res/drawable/neko.png", icon)
            control = root / "DEBIAN/control"
            control.parent.mkdir()
            # t64 names are the Ubuntu 24.04 baseline; a local Arch build is not that baseline.
            control.write_text(f"Package: neko-remoted-desktop\nVersion: {args.version}\nArchitecture: amd64\nMaintainer: LazyCat Community\nSection: net\nPriority: optional\nDepends: libc6 (>= {glibc}), libgtk-4-1 (>= {gtk}), libglib2.0-0t64 (>= {glib}), libpango-1.0-0, libpangocairo-1.0-0, libcairo2, libgdk-pixbuf-2.0-0, libgraphene-1.0-0, libgstreamer1.0-0 (>= {gst}), libgstreamer-plugins-base1.0-0 (>= {gst}), libdbus-1-3, libgcc-s1, libstdc++6\nRecommends: gnome-keyring\nDescription: Native Remoted terminal client\n Manual Relay and device-code pairing with host approval.\n", encoding="utf-8")
            (docs / "build-info.json").write_text(json.dumps(info, indent=2) + "\n")
            package = args.out / f"{stem}.deb"
            run(os.environ.get("DPKG_DEB", "dpkg-deb"), "--root-owner-group", "--build", root, package)
            run(os.environ.get("DPKG_DEB", "dpkg-deb"), "--info", package)
        elif system == "macos":
            app = stage / "Remoted.app"
            contents = app / "Contents"
            macos = contents / "MacOS"
            resources = contents / "Resources"
            macos.mkdir(parents=True)
            resources.mkdir()
            shutil.copy2(binary, macos / BINARY)
            (macos / BINARY).chmod(0o755)
            with (contents / "Info.plist").open("wb") as handle:
                plistlib.dump({"CFBundleIdentifier": APP_ID, "CFBundleName": "Remoted", "CFBundleDisplayName": "小橘远程",
                              "CFBundleExecutable": BINARY, "CFBundlePackageType": "APPL", "CFBundleShortVersionString": args.version,
                              "CFBundleVersion": args.version, "LSMinimumSystemVersion": os.environ.get("MACOSX_DEPLOYMENT_TARGET", "14.0"),
                              "NSHighResolutionCapable": True}, handle)
            shutil.copytree(licenses, resources / "licenses")
            shutil.copy2(stage / "INSTALL.txt", resources / "INSTALL.txt")
            (resources / "build-info.json").write_text(json.dumps(info, indent=2) + "\n")
            run("codesign", "--force", "--sign", "-", "--timestamp=none", app)
            run("codesign", "--verify", "--strict", "--verbose=2", app)
            run("lipo", "-archs", macos / BINARY)
            package = args.out / f"{stem}.zip"
            run("ditto", "-c", "-k", "--keepParent", app, package)
        else:
            shutil.copy2(binary, stage / binary.name)
            (stage / "build-info.json").write_text(json.dumps(info, indent=2) + "\n")
            package = args.out / f"{stem}.zip"
            with zipfile.ZipFile(package, "w", zipfile.ZIP_DEFLATED) as archive:
                for path in stage.rglob("*"):
                    if path.is_file():
                        archive.write(path, path.relative_to(stage))
        (args.out / f"{stem}.build-info.json").write_text(json.dumps(info, indent=2) + "\n")
        checksum = hashlib.sha256(package.read_bytes()).hexdigest()
        (args.out / f"{package.name}.sha256").write_text(f"{checksum}  {package.name}\n")
        print(f"Package: {package}\nSHA-256: {checksum}")


if __name__ == "__main__":
    main()

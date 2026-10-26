#!/usr/bin/env python3
"""Inspect only the generated LPK; never extract or execute its runtime files."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import tarfile

MAX_BYTES = 512 * 1024 * 1024


def verify_contents(filename, profile):
    required = {"package.yml", "manifest.yml", "icon.png", "content.tar"}
    allowed = required | {"deploy_params.yml", "compose.override.yml"} | set(profile["exports"])
    content_files = set(profile["contentFiles"])
    def directory_allowed(name, files):
        return any(name in [str(parent) for parent in PurePosixPath(item).parents] for item in files)
    with tarfile.open(filename) as package:
        seen = set()
        for member in package:
            name = str(PurePosixPath(member.name))
            if member.isdir() and directory_allowed(name, allowed):
                continue
            if not member.isfile() or name not in allowed or name in seen or not 0 < member.size <= MAX_BYTES:
                raise ValueError("Unexpected package entry: only runtime and declared package resources may be published")
            seen.add(name)
        if not required <= seen:
            raise ValueError("LPK package metadata is incomplete")
        seen_content = set()
        total = 0
        with package.extractfile("content.tar") as stream, tarfile.open(fileobj=stream, mode="r|*") as content:
            for member in content:
                name = str(PurePosixPath(member.name))
                if member.isdir() and directory_allowed(name, content_files):
                    continue
                if not member.isfile() or name not in content_files or name in seen_content:
                    raise ValueError("LPK runtime contains an unexpected file or link; refusing to publish source/build files")
                seen_content.add(name)
                total += member.size
                if total > MAX_BYTES:
                    raise ValueError("LPK exceeds the uncompressed size limit")
                if name == profile["binary"]:
                    with content.extractfile(member) as binary:
                        header = binary.read(20)
                    if not (header[:6] == b"\x7fELF\x02\x01" and header[18:20] == b"\x3e\x00" and member.mode & 0o111):
                        raise ValueError("Expected an executable Linux amd64 binary")
        if seen_content != content_files:
            raise ValueError("LPK runtime files are incomplete")


def prepare():
    component = os.environ["COMPONENT"]
    if component not in {"neko", "client", "server"}:
        raise ValueError("Unknown component")
    profile = json.loads(Path(f"components/{component}/profile.json").read_text())
    version = os.environ["LPK_VERSION"]
    if not re.fullmatch(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?", version):
        raise ValueError("Invalid artifact version")
    candidates = list(Path("dist/import").rglob("*.lpk"))
    if len(candidates) != 1 or candidates[0].is_symlink() or not candidates[0].is_file() or not 0 < candidates[0].stat().st_size <= MAX_BYTES:
        raise ValueError("Expected one regular generated LPK")
    verify_contents(candidates[0], profile)
    name = f"{profile['packageId']}-v{version}.lpk"
    destination = Path(profile["root"]) / "dist" / name
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(candidates[0], destination)
    with destination.open("rb") as copied:
        digest = hashlib.file_digest(copied, "sha256").hexdigest()
    destination.with_name("checksums.txt").write_text(f"{digest}  {name}\n")
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write(f"lpk-path={destination}\naction-lpk-path=dist/{name}\nsha256={digest}\n")
    print(f"Verified {profile['packageId']} {version}; SHA256 {digest}")


if __name__ == "__main__":
    prepare()

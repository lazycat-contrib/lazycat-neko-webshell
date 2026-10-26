import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("prepare_lpk", Path(__file__).with_name("prepare-lpk.py"))
prepare_lpk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare_lpk)


class PackageBoundaryTest(unittest.TestCase):
    profile = {"exports": [], "contentFiles": ["bin/ediary-server", "start.sh"], "binary": "bin/ediary-server"}
    def package(self, root, extra=None, link=False):
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode="w") as content:
            files = {"bin/ediary-server": b"\x7fELF\x02\x01" + b"\0" * 12 + b"\x3e\x00", "start.sh": b"#!/bin/sh\nexec /lzcapp/pkg/content/bin/ediary-server\n"}
            if extra:
                files[extra] = b"private data"
            for name, data in files.items():
                info = tarfile.TarInfo(name)
                info.mode = 0o755
                info.size = len(data)
                if link and name == "start.sh":
                    info.type = tarfile.SYMTYPE
                    info.linkname = "/etc/passwd"
                    info.size = 0
                content.addfile(info, io.BytesIO(data))
        path = Path(root) / "app.lpk"
        with tarfile.open(path, mode="w") as package:
            for name in {"package.yml", "manifest.yml", "icon.png", "content.tar"}:
                data = stream.getvalue() if name == "content.tar" else b"metadata"
                info = tarfile.TarInfo(name)
                info.size = len(data)
                package.addfile(info, io.BytesIO(data))
        return path

    def test_runtime_only_package(self):
        with tempfile.TemporaryDirectory() as root:
            prepare_lpk.verify_contents(self.package(root), self.profile)

    def test_rejects_source_git_and_secret_files(self):
        for extra in ["main.go", ".git/config", ".env", "build.sh", "README.md", "../outside"]:
            with self.subTest(extra=extra), tempfile.TemporaryDirectory() as root:
                with self.assertRaises(ValueError):
                    prepare_lpk.verify_contents(self.package(root, extra), self.profile)

    def test_rejects_symlinks(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(ValueError):
                prepare_lpk.verify_contents(self.package(root, link=True), self.profile)


if __name__ == "__main__":
    unittest.main()

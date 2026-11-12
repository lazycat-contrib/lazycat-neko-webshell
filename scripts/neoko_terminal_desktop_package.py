"""Inspect desktop package contents without executing or extracting them.

Derived from the release verifier; verifies PE/ELF/deb layout and Mach-O
ad-hoc code-page hashes, not Developer ID or notarization.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import plistlib
import re
import struct
import tarfile
import zipfile

TARGETS = ('x86_64-pc-windows-msvc', 'aarch64-apple-darwin', 'x86_64-apple-darwin', 'x86_64-unknown-linux-gnu')
NSH = 'f4d68f7f9f31eb7b3ecc8a4cbc31096d5c6238a1'
APP_ID = 'community.lazycat.neko.remoted'
MAX_FILE = 256 * 1024 * 1024
MAX_TOTAL = 512 * 1024 * 1024


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def unique_keys(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, f'duplicate JSON key: {key}')
        result[key] = value
    return result


def read_json(data):
    return json.loads(data, object_pairs_hook=unique_keys)


def safe_path(name):
    while name.startswith('./'):
        name = name[2:]
    path = PurePosixPath(name)
    require(not path.is_absolute() and '..' not in path.parts and '\\' not in name, f'unsafe archive path: {name}')
    return str(path)


def tar_contents(data):
    contents = {}
    modes = {}
    total = 0
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:*') as archive:
        for member in archive:
            name = safe_path(member.name)
            require(member.uid == 0 and member.gid == 0, f'deb member is not root-owned: {name}')
            if member.isdir():
                continue
            require(member.isfile() and name not in contents, f'unsupported/duplicate tar entry: {name}')
            total += member.size
            require(member.size <= MAX_FILE and total <= MAX_TOTAL, 'archive exceeds size budget')
            contents[name] = archive.extractfile(member).read()
            modes[name] = member.mode
    return contents, modes


def deb_contents(package):
    data = package.read_bytes()
    require(data[:8] == b'!<arch>\n', 'not a Debian ar archive')
    members = {}
    offset = 8
    while offset < len(data):
        require(offset + 60 <= len(data), 'truncated ar header')
        header = data[offset:offset + 60]
        require(header[58:60] == b'`\n', 'invalid ar header')
        name = header[:16].decode('ascii').strip().rstrip('/')
        size = int(header[48:58])
        offset += 60
        require(size >= 0 and offset + size <= len(data) and name not in members, 'invalid ar member')
        members[name] = data[offset:offset + size]
        offset += size + size % 2
    require(members.get('debian-binary') == b'2.0\n', 'unsupported Debian package format')
    def archive(prefix):
        names = [name for name in members if name.startswith(prefix + '.tar')]
        require(len(names) == 1, f'expected one {prefix} tar archive')
        return tar_contents(members[names[0]])
    control, _ = archive('control')
    payload, modes = archive('data')
    return control, payload, modes


def zip_contents(package):
    files = {}
    total = 0
    with zipfile.ZipFile(package) as archive:
        require(len(archive.infolist()) < 1000, 'too many ZIP entries')
        for member in archive.infolist():
            name = safe_path(member.filename)
            if member.is_dir() or name.startswith('__MACOSX/'):
                continue
            mode = member.external_attr >> 16
            require(mode & 0o170000 != 0o120000, f'ZIP symlink is not allowed: {name}')
            require(name not in files and member.file_size <= MAX_FILE, f'duplicate/oversized ZIP entry: {name}')
            total += member.file_size
            require(total <= MAX_TOTAL, 'ZIP exceeds size budget')
            files[name] = archive.read(member)  # also checks ZIP CRC
    return files


def verify_pe(data):
    require(len(data) >= 64 and data[:2] == b'MZ', 'missing DOS header')
    offset = struct.unpack_from('<I', data, 60)[0]
    require(offset + 264 <= len(data) and data[offset:offset + 4] == b'PE\0\0', 'invalid PE header')
    require(struct.unpack_from('<H', data, offset + 4)[0] == 0x8664, 'PE is not x64')
    optional = offset + 24
    require(struct.unpack_from('<H', data, optional)[0] == 0x20B, 'PE is not PE32+')
    require(struct.unpack_from('<H', data, optional + 68)[0] == 2, 'PE does not use Windows GUI subsystem')
    cert_offset, cert_size = struct.unpack_from('<II', data, optional + 112 + 4 * 8)
    require(cert_offset == 0 and cert_size == 0, 'unsigned manifest conflicts with PE certificate directory')
    return 'PE32+ x86_64, GUI, unsigned'


def verify_macho(data, target, plist, resources):
    require(len(data) >= 32 and data[:4] == b'\xcf\xfa\xed\xfe', 'expected a thin little-endian Mach-O 64 binary')
    cpu = struct.unpack_from('<I', data, 4)[0]
    require(cpu == (0x0100000C if target.startswith('aarch64') else 0x01000007), 'Mach-O CPU does not match target')
    require(struct.unpack_from('<I', data, 12)[0] == 2, 'Mach-O is not an executable')
    commands, size = struct.unpack_from('<II', data, 16)
    require(32 + size <= len(data) and commands < 4096, 'invalid Mach-O load commands')
    signature = None
    offset = 32
    for _ in range(commands):
        command, length = struct.unpack_from('<II', data, offset)
        require(length >= 8 and offset + length <= 32 + size, 'invalid Mach-O command length')
        if command == 0x1D:
            require(length == 16 and signature is None, 'invalid/duplicate LC_CODE_SIGNATURE')
            position, count = struct.unpack_from('<II', data, offset + 8)
            require(position + count <= len(data), 'code signature outside Mach-O')
            signature = data[position:position + count]
        offset += length
    require(signature is not None and len(signature) >= 12, 'missing Mach-O code signature')
    magic, length, count = struct.unpack_from('>III', signature)
    require(magic == 0xFADE0CC0 and length <= len(signature) and 12 + count * 8 <= length, 'invalid signature superblob')
    verified = 0
    for index in range(count):
        slot, position = struct.unpack_from('>II', signature, 12 + index * 8)
        require(position + 8 <= length, 'invalid signature slot')
        blob_magic, blob_length = struct.unpack_from('>II', signature, position)
        require(position + blob_length <= length, 'invalid signature blob length')
        if slot != 0 and not 0x1000 <= slot < 0x1005:
            continue
        code = signature[position:position + blob_length]
        require(blob_magic == 0xFADE0C02 and len(code) >= 44, 'invalid CodeDirectory')
        version, flags, hash_offset, _, special, pages, limit = struct.unpack_from('>7I', code, 8)
        hash_size, hash_type, _, shift = struct.unpack_from('4B', code, 36)
        require(flags & 2, 'CodeDirectory is not ad-hoc signed')
        require(hash_type in (1, 2, 3, 4) and shift <= 20, 'unsupported CodeDirectory digest/page size')
        digest = {1: hashlib.sha1, 2: hashlib.sha256, 3: hashlib.sha256, 4: hashlib.sha384}[hash_type]
        require(hash_size == {1: 20, 2: 32, 3: 20, 4: 48}[hash_type], 'invalid digest size')
        page_size = (1 << shift) if shift else limit
        require(0 < limit <= len(data) and pages == (limit + page_size - 1) // page_size, 'invalid signed code limit')
        require(hash_offset >= special * hash_size and hash_offset + pages * hash_size <= len(code), 'invalid CodeDirectory hash offsets')
        for page in range(pages):
            actual = digest(data[page * page_size:min((page + 1) * page_size, limit)]).digest()[:hash_size]
            expected = code[hash_offset + page * hash_size:hash_offset + (page + 1) * hash_size]
            require(actual == expected, f'Mach-O signed page {page} digest mismatch')
        for slot_number, content in ((1, plist), (3, resources)):
            if special >= slot_number:
                expected = code[hash_offset - slot_number * hash_size:hash_offset - (slot_number - 1) * hash_size]
                if any(expected):
                    require(digest(content).digest()[:hash_size] == expected, f'CodeDirectory special slot {slot_number} mismatch')
        verified += 1
    require(verified > 0, 'no verified CodeDirectory')
    return f'Mach-O {"arm64" if target.startswith("aarch64") else "x86_64"}, ad-hoc code-page hashes verified; not Developer ID/notarization'


def verify_group(root, args, target):
    stem = f'neoko-terminal-{args.version}-{target}'
    extension = '.deb' if target.endswith('linux-gnu') else '.zip'
    name = stem + extension
    paths = list(root.rglob(name))
    require(len(paths) == 1, f'expected exactly one {name}, got {len(paths)}')
    package = paths[0]
    require(package.stat().st_size <= MAX_FILE, 'package exceeds size budget')
    checksum = (package.parent / (name + '.sha256')).read_text().strip()
    require(re.fullmatch(r'[0-9a-f]{64}  ' + re.escape(name), checksum) is not None, 'invalid checksum sidecar')
    digest = sha(package.read_bytes())
    require(checksum[:64] == digest, 'package SHA-256 mismatch')
    info = read_json((package.parent / (stem + '.build-info.json')).read_bytes())
    expected = dict(desktop_version=args.version, crate_version=args.crate_version, target=target, source_sha=args.source, nsh_revision=args.nsh)
    for key, value in expected.items():
        require(info.get(key) == value, f'{key} mismatch: {info.get(key)!r} != {value!r}')
    require(info.get('source_dirty') is False, 'source_dirty must be false')
    require(re.fullmatch('[0-9a-f]{64}', info.get('cargo_binary_sha256', '')) is not None, 'invalid Cargo binary SHA')
    if target.endswith('linux-gnu'):
        control, files, modes = deb_contents(package)
        fields = dict(line.split(': ', 1) for line in control['control'].decode().splitlines() if ': ' in line and not line.startswith(' '))
        require(fields.get('Package') == 'neoko-terminal' and fields.get('Version') == args.version and fields.get('Architecture') == 'amd64', 'deb control metadata mismatch')
        binary = files['usr/bin/neoko-terminal']
        require(binary[:6] == b'\x7fELF\x02\x01' and struct.unpack_from('<H', binary, 18)[0] == 62, 'ELF is not x86_64 little-endian 64-bit')
        require(modes['usr/bin/neoko-terminal'] & 0o111, 'deb binary is not executable')
        require(sha(binary) == info['cargo_binary_sha256'], 'ELF SHA mismatch')
        internal = files['usr/share/doc/neoko-terminal/build-info.json']
        require(info.get('signing') == 'unsigned', 'deb signing metadata mismatch')
        entry = files[f'usr/share/applications/{APP_ID}.desktop'].decode()
        require('Exec=neoko-terminal\n' in entry and f'Icon={APP_ID}\n' in entry, 'desktop entry mismatch')
        require(files[f'usr/share/pixmaps/{APP_ID}.png'][:8] == b'\x89PNG\r\n\x1a\n', 'missing/invalid desktop icon')
        for key, package_name in [('libc6', 'libc6'), ('gtk4', 'libgtk-4-1'), ('glib', 'libglib2.0-0t64'), ('gstreamer', 'libgstreamer1.0-0')]:
            value = info['build_runtime_versions'][key]
            require(f'{package_name} (>= {value})' in fields['Depends'], f'deb runtime dependency mismatch for {key}')
        architecture = 'ELF64 x86_64'
    else:
        files = zip_contents(package)
        if target.endswith('windows-msvc'):
            internal = files['build-info.json']
            binary = files['neoko-terminal.exe']
            require(sha(binary) == info['cargo_binary_sha256'], 'PE SHA mismatch')
            require(info.get('signing') == 'unsigned', 'Windows signing metadata mismatch')
            architecture = verify_pe(binary)
        else:
            prefix = 'neoko-terminal.app/Contents/'
            internal = files[prefix + 'Resources/build-info.json']
            plist_bytes = files[prefix + 'Info.plist']
            plist = plistlib.loads(plist_bytes)
            require(plist.get('CFBundleIdentifier') == APP_ID and plist.get('CFBundleExecutable') == 'neoko-terminal', 'APP identity mismatch')
            require(plist.get('CFBundleShortVersionString') == args.version and plist.get('CFBundleVersion') == args.version, 'APP version mismatch')
            require(plist.get('LSMinimumSystemVersion') == '14.0', 'APP minimum OS mismatch')
            require(info.get('signing') == 'ad-hoc; not notarized', 'APP signing metadata mismatch')
            architecture = verify_macho(files[prefix + 'MacOS/neoko-terminal'], target, plist_bytes, files[prefix + '_CodeSignature/CodeResources'])
    require(read_json(internal) == info, 'package-internal build-info differs from sidecar')
    return dict(target=target, package=str(package), package_sha256=digest, source_sha=info['source_sha'], desktop_version=args.version, source_dirty=info['source_dirty'], architecture=architecture)

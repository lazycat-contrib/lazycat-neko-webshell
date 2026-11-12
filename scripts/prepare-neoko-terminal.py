#!/usr/bin/env python3
"""Validate a native artifact without executing or blindly extracting its content."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import selectors
import shutil
import signal
import stat
import struct
import subprocess
import tempfile
import time
import zipfile

BASE = Path(__file__).resolve().parents[1]
PROFILE = BASE / 'components/neoko-terminal/profile.json'
SEMVER = r'(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)'
MANIFEST_FIELDS = {
    'schemaVersion', 'component', 'version', 'protocolVersion', 'sourceRepository',
    'sourceCommit', 'sourceRunId', 'sourceRunAttempt', 'sourceWorkflow', 'sourceEvent',
    'sourceRef', 'apkName', 'apkSha256', 'apkSize', 'packageName', 'versionCode',
    'abi', 'signingCertificateSha256', 'minSdk', 'targetSdk', 'debuggable',
}
NATIVE_BUILD_INPUTS = {'ghostty_source_revision': '108cacb17ed8990840cd14abfce43d8ed8503ca1', 'ghostty_wrapper_revision': 'cd4d497e8c698b27054a677ce19d1bd1a1a4d8bf', 'zig_version': '0.17.1'}
SOURCE_FIELDS = ('version', 'sourceRepository', 'sourceCommit', 'sourceRunId',
                 'sourceRunAttempt', 'sourceWorkflow', 'sourceEvent', 'sourceRef')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'Duplicate JSON key')
        result[key] = value
    return result


def read_json(data):
    return json.loads(data, object_pairs_hook=unique_object)


def validate_profile(profile):
    require(profile['component'] == 'neoko-terminal', 'Wrong native component')
    require(type(profile.get('protocolVersion')) is int and profile['protocolVersion'] == 3, 'Native protocol must be version 3')
    require(profile['sourceWorkflow'] == 'neoko-terminal-android.yml', 'Wrong source workflow')
    require(profile['tagPrefix'] == 'neoko-terminal-android-v', 'Wrong native tag prefix')
    require(profile['artifactPrefix'] == 'neoko-terminal-android-v', 'Wrong native artifact prefix')
    require(profile.get('nativeBuildInputs') == NATIVE_BUILD_INPUTS, 'Unexpected native build input pins')
    fingerprint = profile.get('signingCertificateSha256')
    require(isinstance(fingerprint, str) and re.fullmatch(r'[0-9a-f]{64}', fingerprint)
            and fingerprint != '0' * 64, 'A production signing certificate fingerprint must be pinned')
    for field in ('maxArchiveBytes', 'maxApkBytes', 'maxApkExpandedBytes', 'maxApkEntries'):
        require(type(profile[field]) is int and 0 < profile[field] <= 1024 ** 3, 'Invalid native resource bound')


def validate_manifest(manifest, selection, profile, apk_name, apk_size, apk_sha):
    require(type(manifest) is dict and set(manifest) == MANIFEST_FIELDS, 'Unexpected provenance schema fields')
    for field in ('schemaVersion', 'protocolVersion', 'sourceRunId', 'sourceRunAttempt',
                  'apkSize', 'versionCode', 'minSdk', 'targetSdk'):
        require(type(manifest[field]) is int and manifest[field] > 0, f'Invalid provenance integer: {field}')
    for field in MANIFEST_FIELDS - {'schemaVersion', 'protocolVersion', 'sourceRunId', 'sourceRunAttempt',
                                    'apkSize', 'versionCode', 'minSdk', 'targetSdk', 'debuggable'}:
        require(type(manifest[field]) is str, f'Invalid provenance string: {field}')
    require(manifest['schemaVersion'] == 1 and manifest['component'] == profile['component'], 'Wrong provenance component/schema')
    require(re.fullmatch(SEMVER, manifest['version']), 'Native version must be stable SemVer')
    require(re.fullmatch(r'[0-9a-f]{40}', manifest['sourceCommit']), 'Invalid source commit')
    require(manifest['sourceEvent'] in ('push', 'workflow_dispatch'), 'Untrusted provenance event')
    for field in SOURCE_FIELDS:
        require(type(selection[field]) is type(manifest[field]) and manifest[field] == selection[field], f'Provenance source mismatch: {field}')
    require(manifest['sourceRepository'] == profile['sourceRepository']
            and manifest['sourceWorkflow'] == profile['sourceWorkflow']
            and manifest['sourceRef'] == 'refs/tags/' + profile['tagPrefix'] + manifest['version'], 'Untrusted provenance source')
    for field in ('packageName', 'abi', 'protocolVersion', 'minSdk', 'targetSdk', 'signingCertificateSha256'):
        require(manifest[field] == profile[field], f'Provenance differs from public profile: {field}')
    require(manifest['debuggable'] is False, 'Debug builds cannot be published')
    require(manifest['apkName'] == apk_name and manifest['apkSize'] == apk_size
            and manifest['apkSha256'] == apk_sha, 'APK digest/size/name differs from provenance')


def safe_entry(info, flat=False):
    name = info.filename
    parts = PurePosixPath(name).parts
    require(name == info.orig_filename and name and '\\' not in name and ':' not in name
            and not name.startswith('/') and all(ord(char) >= 32 and ord(char) != 127 for char in name)
            and all(part not in ('', '.', '..') for part in name.rstrip('/').split('/')),
            'Unsafe ZIP entry path')
    require(not flat or (len(parts) == 1 and not info.is_dir()), 'Native artifact must contain flat files only')
    mode = info.external_attr >> 16
    require(stat.S_IFMT(mode) in (0, stat.S_IFREG, stat.S_IFDIR) and
            (not flat or stat.S_IFMT(mode) != stat.S_IFDIR), 'ZIP symlink or special entry is forbidden')
    require(not info.flag_bits & 1 and info.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED),
            'Unsupported or encrypted ZIP entry')


def zip_directory_guard(filename, maximum):
    with Path(filename).open('rb') as source:
        source.seek(0, os.SEEK_END)
        size = source.tell()
        source.seek(max(0, size - 65557))
        tail = source.read(65557)
        position = tail.rfind(b'PK\x05\x06')
        require(position >= 0 and len(tail) - position >= 22, 'Missing ZIP directory footer')
        _, disk, directory_disk, disk_entries, entries, directory_size, offset, comment = struct.unpack_from('<4s4H2LH', tail, position)
        require(disk == directory_disk == 0 and disk_entries == entries and 0 < entries <= maximum,
                'ZIP directory entry count or disk layout exceeds bound')
        require(position + 22 + comment == len(tail) and offset + directory_size + 22 + comment == size,
                'ZIP directory extent or trailing content is invalid')
        source.seek(offset)
        end = offset + directory_size
        count = 0
        while source.tell() < end:
            header = source.read(46)
            require(len(header) == 46 and header[:4] == b'PK\x01\x02', 'Invalid ZIP directory header')
            name, extra, note = struct.unpack_from('<3H', header, 28)
            count += 1
            require(count <= maximum and 0 < name <= 4096 and note <= 4096, 'ZIP directory metadata exceeds bound')
            source.seek(name + extra + note, os.SEEK_CUR)
            require(source.tell() <= end, 'ZIP directory record exceeds extent')
        require(count == entries, 'ZIP directory count differs from footer')


def inspect_apk_zip(apk, profile, source_commit):
    total = 0
    native = 0
    zip_directory_guard(apk, profile['maxApkEntries'])
    with zipfile.ZipFile(apk) as archive:
        entries = archive.infolist()
        require(0 < len(entries) <= profile['maxApkEntries'], 'APK entry count exceeds bound')
        require(len({info.filename for info in entries}) == len(entries), 'Duplicate APK entries')
        names = {info.filename for info in entries}
        require({'AndroidManifest.xml', 'classes.dex'} <= names, 'APK is missing manifest or runtime classes')
        require(sum(info.file_size for info in entries) <= profile['maxApkExpandedBytes'], 'APK expanded content exceeds bound')
        for info in entries:
            safe_entry(info)
            if info.filename.startswith('lib/') and not info.is_dir():
                parts = info.filename.split('/')
                require(len(parts) == 3 and parts[1] == profile['abi'] and parts[2].endswith('.so'), 'Unexpected APK native ABI/content')
                native += 1
            with archive.open(info) as content:
                header = content.read(64)
                total += len(header)
                if info.filename.startswith('lib/') and not info.is_dir():
                    require(len(header) >= 20 and header[:6] == b'\x7fELF\x02\x01'
                            and int.from_bytes(header[18:20], 'little') == 183, 'Native library is not ARM64 ELF')
                while chunk := content.read(1024 * 1024):
                    total += len(chunk)
                    require(total <= profile['maxApkExpandedBytes'], 'APK decompression exceeds bound')
        require(native > 0, 'APK has no ARM64 native library')
        metadata_name = 'assets/build-inputs.json'
        require(metadata_name in names, 'APK is missing native build inputs')
        require(0 < archive.getinfo(metadata_name).file_size <= 8192, 'APK native build inputs exceed bound')
        metadata = read_json(archive.read(metadata_name))
        require(type(metadata) is dict and set(metadata) == {'source_sha', 'source_dirty', *NATIVE_BUILD_INPUTS},
                'Unexpected APK native build input fields')
        require(type(metadata['source_sha']) is str and re.fullmatch(r'[0-9a-f]{40}', metadata['source_sha'])
                and metadata['source_sha'] == source_commit, 'APK native build source differs from selected commit')
        require(metadata['source_dirty'] is False, 'APK native build source must be clean')
        require(all(metadata[key] == profile['nativeBuildInputs'][key] for key in NATIVE_BUILD_INPUTS),
                'APK native build input pins differ from public profile')


def tool_output(command):
    process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               start_new_session=True,
                               env={key: value for key, value in os.environ.items()
                                    if key in ('PATH', 'JAVA_HOME', 'LANG', 'SYSTEMROOT', 'TMPDIR')})
    output = bytearray()
    deadline = time.monotonic() + 45
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while True:
                remaining = deadline - time.monotonic()
                require(remaining > 0, 'Android inspection tool timed out')
                require(selector.select(remaining), 'Android inspection tool timed out')
                chunk = os.read(process.stdout.fileno(), 65536)
                if not chunk:
                    break
                output.extend(chunk)
                require(len(output) <= 1024 * 1024, 'Android inspection output exceeds bound')
        process.wait(timeout=max(0.01, deadline - time.monotonic()))
        require(process.returncode == 0, 'Android inspection or signature verification failed')
        return output.decode('utf-8', errors='strict')
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        process.stdout.close()


def inspect_android(apk, manifest, profile, aapt, apksigner, run=tool_output):
    badging = run([str(aapt), 'dump', 'badging', str(apk)])
    packages = re.findall(r"^package: name='([^']+)' versionCode='([0-9]+)' versionName='([^']+)'", badging, re.M)
    require(len(packages) == 1 and packages[0] == (profile['packageName'], str(manifest['versionCode']), manifest['version']), 'APK package/version does not match provenance')
    for label, expected in (('sdkVersion', profile['minSdk']), ('targetSdkVersion', profile['targetSdk'])):
        require(re.findall(r"^" + label + r":'([0-9]+)'$", badging, re.M) == [str(expected)], f'APK {label} differs from profile')
    require(re.findall(r"^native-code: (.+)$", badging, re.M) == ["'" + profile['abi'] + "'"], 'APK reports unexpected ABIs')
    require(not re.search(r'^application-debuggable', badging, re.M), 'Debuggable APK is forbidden')
    certificates = run([str(apksigner), 'verify', '--verbose', '--print-certs', str(apk)])
    fingerprints = re.findall(r'^Signer #[0-9]+ certificate SHA-256 digest: ([0-9a-fA-F]{64})$', certificates, re.M)
    require(len(fingerprints) == 1 and fingerprints[0].lower() == profile['signingCertificateSha256'], 'APK release signing certificate differs from public pin')
    require(not re.search(r'CN\s*=\s*Android Debug', certificates, re.I), 'Android debug signature is forbidden')


def prepare(archive_path, selection, profile, output, aapt, apksigner, inspect=inspect_android):
    validate_profile(profile)
    version = selection['version']
    require(isinstance(version, str) and re.fullmatch(SEMVER, version), 'Invalid selected version')
    require(selection['artifactName'] == profile['artifactPrefix'] + version, 'Wrong selected artifact name')
    archive_path, output = Path(archive_path), Path(output)
    require(archive_path.is_file() and 0 < archive_path.stat().st_size <= profile['maxArchiveBytes'], 'Artifact archive exceeds bound')
    with archive_path.open('rb') as source:
        archive_sha = hashlib.file_digest(source, 'sha256').hexdigest()
    require(selection['artifactDigest'] == 'sha256:' + archive_sha and selection['artifactSize'] == archive_path.stat().st_size,
            'Artifact archive digest/size differs from GitHub metadata')
    apk_name = f'neoko-terminal-v{version}-android-arm64.apk'
    expected = {apk_name, 'checksums.txt', 'provenance.json'}
    output.parent.mkdir(parents=True, exist_ok=True)
    require(not output.exists() and not output.is_symlink(), 'Verified output already exists; refusing replacement')
    with tempfile.TemporaryDirectory(prefix='.native-verify-', dir=output.parent) as scratch:
        scratch = Path(scratch)
        zip_directory_guard(archive_path, 3)
        with zipfile.ZipFile(archive_path) as archive:
            entries = archive.infolist()
            require(len(entries) == 3 and {info.filename for info in entries} == expected, 'Expected exactly APK/checksums/provenance; source and signing files are forbidden')
            for info in entries:
                safe_entry(info, flat=True)
                limit = profile['maxApkBytes'] if info.filename == apk_name else 8192
                require(0 < info.file_size <= limit, 'Artifact file exceeds content bound')
                count = 0
                with archive.open(info) as source, (scratch / info.filename).open('xb') as destination:
                    while chunk := source.read(min(1024 * 1024, limit + 1 - count)):
                        count += len(chunk)
                        require(count <= limit, 'Artifact extraction exceeds bound')
                        destination.write(chunk)
                require(count == info.file_size, 'Artifact size changed while reading')
        apk = scratch / apk_name
        with apk.open('rb') as source:
            apk_sha = hashlib.file_digest(source, 'sha256').hexdigest()
        manifest = read_json((scratch / 'provenance.json').read_bytes())
        validate_manifest(manifest, selection, profile, apk_name, apk.stat().st_size, apk_sha)
        require((scratch / 'checksums.txt').read_bytes() == f'{apk_sha}  {apk_name}\n'.encode(), 'Checksum content differs from verified APK')
        inspect_apk_zip(apk, profile, manifest['sourceCommit'])
        inspect(apk, manifest, profile, aapt, apksigner)
        hashes = {name: hashlib.sha256((scratch / name).read_bytes()).hexdigest() for name in sorted(expected)}
        output.mkdir(mode=0o700)
        for name in sorted(expected):
            shutil.move(str(scratch / name), output / name)
    verification = {'schemaVersion': 1, 'selection': selection,
                    'signingCertificateSha256': profile['signingCertificateSha256'], 'files': hashes}
    marker = output.parent / 'verification.json'
    with marker.open('x') as handle:
        json.dump(verification, handle, sort_keys=True)
        handle.write('\n')
    return verification


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', required=True)
    parser.add_argument('--selection', required=True)
    parser.add_argument('--output', default='dist/neoko-terminal/verified')
    parser.add_argument('--aapt', required=True)
    parser.add_argument('--apksigner', required=True)
    args = parser.parse_args()
    result = prepare(args.archive, read_json(Path(args.selection).read_bytes()), read_json(PROFILE.read_bytes()),
                     args.output, args.aapt, args.apksigner)
    print(f"Verified native client {result['selection']['version']}; production APK signature and provenance match")


if __name__ == '__main__':
    main()

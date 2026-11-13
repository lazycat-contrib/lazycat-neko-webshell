#!/usr/bin/env python3
"""Verify four private desktop artifact ZIPs without running their packages."""
import argparse
from types import SimpleNamespace
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import tempfile
import zipfile

BASE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('android_verifier', BASE / 'scripts/prepare-neoko-terminal.py')
common = importlib.util.module_from_spec(spec)
spec.loader.exec_module(common)
package_spec = importlib.util.spec_from_file_location('desktop_package_verifier', BASE / 'scripts/neoko_terminal_desktop_package.py')
package_verifier = importlib.util.module_from_spec(package_spec)
package_spec.loader.exec_module(package_verifier)
require = common.require
TARGETS = ['x86_64-unknown-linux-gnu', 'x86_64-pc-windows-msvc', 'aarch64-apple-darwin', 'x86_64-apple-darwin']
PROFILE = BASE / 'components/neoko-terminal/desktop-profile.json'
NATIVE_BUILD_INPUTS = {
    'ghostty_source_revision': '108cacb17ed8990840cd14abfce43d8ed8503ca1',
    'ghostty_wrapper_revision': 'cd4d497e8c698b27054a677ce19d1bd1a1a4d8bf',
    'zig_version': '0.17.1',
}


def validate_profile(profile):
    require(profile['component'] == 'neoko-terminal'
            and profile['sourceRepository'] == 'ca-x/lazycat-neko-webshell'
            and profile['publicRepository'] == 'lazycat-contrib/lazycat-neko-webshell'
            and profile['sourceWorkflow'] == 'neoko-terminal-desktop.yml'
            and profile['tagPrefix'] == 'neoko-terminal-desktop-v'
            and profile['artifactPrefix'] == 'neoko-terminal-desktop-'
            and profile['crateVersion'] == '0.4.3'
            and profile.get('nativeBuildInputs') == NATIVE_BUILD_INPUTS
            and profile['packageName'] == 'community.lazycat.neko.remoted'
            and re.fullmatch(r'[0-9a-f]{40}', profile['nshRevision'])
            and profile['targets'] == TARGETS, 'Unexpected desktop profile')
    for field in ('maxArchiveBytes', 'maxPackageBytes', 'maxMetadataBytes'):
        require(type(profile[field]) is int and 0 < profile[field] <= 1024 ** 3, 'Invalid desktop resource bound')


def validate_selection(selection, profile):
    require(type(selection['schemaVersion']) is int and selection['schemaVersion'] == 1
            and re.fullmatch(common.SEMVER, selection['version'])
            and re.fullmatch(r'[0-9a-f]{40}', selection['sourceCommit'])
            and selection['sourceRepository'] == profile['sourceRepository']
            and selection['sourceWorkflow'] == profile['sourceWorkflow']
            and selection['sourceEvent'] in ('push', 'workflow_dispatch')
            and selection['sourceRef'] == 'refs/tags/' + profile['tagPrefix'] + selection['version'], 'Invalid desktop source selection')
    for field in ('sourceRunId', 'sourceRunAttempt'):
        require(type(selection[field]) is int and selection[field] > 0, 'Invalid desktop run identity')
    artifacts = selection['artifacts']
    require(type(artifacts) is list and len(artifacts) == 4, 'Expected four desktop target artifacts')
    require(len({a['artifactId'] for a in artifacts}) == 4, 'Duplicate desktop artifact ID')
    for target, artifact in zip(TARGETS, artifacts):
        require(artifact['target'] == target
                and artifact['artifactName'] == f"{profile['artifactPrefix']}{selection['version']}-{target}"
                and type(artifact['artifactId']) is int and artifact['artifactId'] > 0
                and type(artifact['artifactSize']) is int and 0 < artifact['artifactSize'] <= profile['maxArchiveBytes']
                and re.fullmatch(r'sha256:[0-9a-f]{64}', artifact['artifactDigest']), 'Invalid desktop artifact selection')


def validate_info(info, selection, profile, target):
    fields = {'desktop_version', 'crate_version', 'target', 'source_sha', 'source_dirty',
              'nsh_revision', 'signing', 'cargo_binary_sha256'} | set(NATIVE_BUILD_INPUTS)
    linux = target.endswith('linux-gnu')
    if linux:
        fields.add('build_runtime_versions')
    require(type(info) is dict and set(info) == fields, 'Unexpected desktop build provenance fields')
    require(info['desktop_version'] == selection['version'] and info['target'] == target
            and info['source_sha'] == selection['sourceCommit'] and info['source_dirty'] is False
            and info['nsh_revision'] == profile['nshRevision'], 'Desktop build provenance source/target differs')
    require(type(info['crate_version']) is str and info['crate_version'] == profile['crateVersion']
            and type(info['cargo_binary_sha256']) is str and re.fullmatch(r'[0-9a-f]{64}', info['cargo_binary_sha256']), 'Invalid desktop build provenance value')
    require(all(info[key] == profile['nativeBuildInputs'][key] for key in NATIVE_BUILD_INPUTS),
            'Desktop native build input pin differs')
    require(info['signing'] == ('ad-hoc; not notarized' if target.endswith('apple-darwin') else 'unsigned'), 'Unexpected desktop signing claim')
    if linux:
        versions = info['build_runtime_versions']
        require(type(versions) is dict and set(versions) == {'libc6', 'gtk4', 'glib', 'gstreamer'}
                and all(type(v) is str and re.fullmatch(r'[0-9]+(?:\.[0-9]+){1,3}', v) for v in versions.values()), 'Invalid Linux runtime provenance')


def prepare(directory, selection, profile):
    validate_profile(profile)
    validate_selection(selection, profile)
    directory = Path(directory)
    output = directory / 'verified'
    marker = directory / 'verification.json'
    require(not output.exists() and not output.is_symlink() and not marker.exists() and not marker.is_symlink(), 'Desktop verified output already exists')
    hashes = {}
    with tempfile.TemporaryDirectory(prefix='.desktop-verify-', dir=directory) as scratch:
        scratch = Path(scratch)
        for artifact in selection['artifacts']:
            target = artifact['target']
            archive_path = directory / (target + '.zip')
            require(archive_path.is_file() and 0 < archive_path.stat().st_size <= profile['maxArchiveBytes'], 'Desktop archive exceeds bound')
            with archive_path.open('rb') as source:
                digest = hashlib.file_digest(source, 'sha256').hexdigest()
            require('sha256:' + digest == artifact['artifactDigest'] and archive_path.stat().st_size == artifact['artifactSize'], 'Desktop archive digest/size differs')
            stem = f"neoko-terminal-{selection['version']}-{target}"
            package = stem + ('.deb' if target.endswith('linux-gnu') else '.zip')
            checksum, info_name = package + '.sha256', stem + '.build-info.json'
            expected = {package, checksum, info_name}
            common.zip_directory_guard(archive_path, 3)
            with zipfile.ZipFile(archive_path) as archive:
                entries = archive.infolist()
                require(len(entries) == 3 and {entry.filename for entry in entries} == expected, 'Expected exactly package/checksum/build-info for desktop target')
                for entry in entries:
                    common.safe_entry(entry, flat=True)
                    limit = profile['maxPackageBytes'] if entry.filename == package else profile['maxMetadataBytes']
                    require(0 < entry.file_size <= limit, 'Desktop artifact content exceeds bound')
                    count = 0
                    with archive.open(entry) as source, (scratch / entry.filename).open('xb') as destination:
                        while chunk := source.read(min(1024 * 1024, limit + 1 - count)):
                            count += len(chunk)
                            require(count <= limit, 'Desktop decompression exceeds bound')
                            destination.write(chunk)
                    require(count == entry.file_size, 'Desktop entry size changed')
            with (scratch / package).open('rb') as source:
                package_hash = hashlib.file_digest(source, 'sha256').hexdigest()
            checksum_line = f'{package_hash}  {package}'.encode()
            allowed_checksums = [checksum_line + b'\n']
            if target.endswith('windows-msvc'):
                allowed_checksums.append(checksum_line + b'\r\n')
            require((scratch / checksum).read_bytes() in allowed_checksums, 'Desktop checksum differs from package')
            validate_info(common.read_json((scratch / info_name).read_bytes()), selection, profile, target)
            package_verifier.verify_group(scratch, SimpleNamespace(
                version=selection['version'], crate_version=profile['crateVersion'],
                source=selection['sourceCommit'], nsh=profile['nshRevision'],
                native_build_inputs=profile['nativeBuildInputs']), target)
            for name in sorted(expected):
                with (scratch / name).open('rb') as source:
                    hashes[name] = hashlib.file_digest(source, 'sha256').hexdigest()
        output.mkdir(mode=0o700)
        for name in hashes:
            shutil.move(str(scratch / name), output / name)
    evidence = {'schemaVersion': 1, 'selection': selection, 'profile': profile, 'files': hashes}
    with marker.open('x') as handle:
        json.dump(evidence, handle, sort_keys=True)
        handle.write('\n')
    return evidence


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', default='dist/neoko-terminal-desktop')
    args = parser.parse_args()
    directory = Path(args.directory)
    result = prepare(directory, common.read_json((directory / 'selection.json').read_bytes()), common.read_json(PROFILE.read_bytes()))
    print(f"Verified four desktop targets, twelve files, source commit {result['selection']['sourceCommit']}")


if __name__ == '__main__':
    main()

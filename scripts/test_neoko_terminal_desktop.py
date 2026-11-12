import hashlib
import io
import plistlib
import struct
import tarfile
import importlib.util
import json
from pathlib import Path
import stat
import tempfile
import unittest
import warnings
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('desktop', ROOT / 'scripts/prepare-neoko-terminal-desktop.py')
desktop = importlib.util.module_from_spec(spec)
spec.loader.exec_module(desktop)


def package_fixture(target, info, compression='gz'):
    """Small structural fixtures; actual runtime evidence comes from real CI packages."""
    files = {}
    if target.endswith('linux-gnu'):
        binary = bytearray(64)
        binary[:6] = b'\x7fELF\x02\x01'
        struct.pack_into('<H', binary, 18, 62)
        info['cargo_binary_sha256'] = hashlib.sha256(binary).hexdigest()
        files = {'usr/bin/neoko-terminal': bytes(binary),
                 'usr/share/doc/neoko-terminal/build-info.json': json.dumps(info).encode(),
                 'usr/share/applications/community.lazycat.neko.remoted.desktop': b'Exec=neoko-terminal\nIcon=community.lazycat.neko.remoted\n',
                 'usr/share/pixmaps/community.lazycat.neko.remoted.png': b'\x89PNG\r\n\x1a\n'}
        def tar(entries):
            output = io.BytesIO()
            with tarfile.open(fileobj=output, mode='w:' + compression) as archive:
                for name, data in entries.items():
                    entry = tarfile.TarInfo(name)
                    entry.size = len(data)
                    entry.mode = 0o755 if name.startswith('usr/bin/') else 0o644
                    archive.addfile(entry, io.BytesIO(data))
            return output.getvalue()
        versions = info['build_runtime_versions']
        deps = ', '.join(f'{name} (>= {versions[key]})' for key, name in
                         [('libc6', 'libc6'), ('gtk4', 'libgtk-4-1'), ('glib', 'libglib2.0-0t64'), ('gstreamer', 'libgstreamer1.0-0')])
        control = f'Package: neoko-terminal\nVersion: 0.3.0\nArchitecture: amd64\nDepends: {deps}\n'.encode()
        output = bytearray(b'!<arch>\n')
        for name, data in [('debian-binary', b'2.0\n'), ('control.tar.' + compression, tar({'control': control})), ('data.tar.' + compression, tar(files))]:
            output.extend(f'{name + "/":<16}{0:<12}{0:<6}{0:<6}{"100644":<8}{len(data):<10}`\n'.encode())
            output.extend(data)
            if len(data) % 2:
                output.extend(b'\n')
        return bytes(output)
    if target.endswith('windows-msvc'):
        binary = bytearray(328)
        binary[:2] = b'MZ'
        struct.pack_into('<I', binary, 60, 64)
        binary[64:68] = b'PE\0\0'
        struct.pack_into('<H', binary, 68, 0x8664)
        struct.pack_into('<H', binary, 88, 0x20B)
        struct.pack_into('<H', binary, 156, 2)
        info['cargo_binary_sha256'] = hashlib.sha256(binary).hexdigest()
        files = {'neoko-terminal.exe': bytes(binary), 'build-info.json': json.dumps(info).encode()}
    else:
        prefix = 'neoko-terminal.app/Contents/'
        plist = plistlib.dumps({'CFBundleIdentifier': 'community.lazycat.neko.remoted',
                               'CFBundleExecutable': 'neoko-terminal', 'CFBundleShortVersionString': '0.3.0',
                               'CFBundleVersion': '0.3.0', 'LSMinimumSystemVersion': '14.0'})
        resources = b'<plist/>'
        # A thin Mach-O with one signed code page and bound plist/resource special slots.
        binary = bytearray(48)
        struct.pack_into('<8I', binary, 0, 0xFEEDFACF, 0x0100000C if target.startswith('aarch64') else 0x01000007,
                         0, 2, 1, 16, 0, 0)
        struct.pack_into('<4I', binary, 32, 0x1D, 16, 48, 192)
        code = bytearray(172)
        struct.pack_into('>9I', code, 0, 0xFADE0C02, 172, 0x20001, 2, 140, 0, 3, 1, 48)
        struct.pack_into('4B', code, 36, 32, 2, 0, 12)
        code[44:76] = hashlib.sha256(resources).digest()
        code[108:140] = hashlib.sha256(plist).digest()
        code[140:172] = hashlib.sha256(binary).digest()
        signature = struct.pack('>5I', 0xFADE0CC0, 192, 1, 0, 20) + code
        files = {prefix + 'MacOS/neoko-terminal': bytes(binary) + signature,
                 prefix + 'Info.plist': plist, prefix + '_CodeSignature/CodeResources': resources,
                 prefix + 'Resources/build-info.json': json.dumps(info).encode()}
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w') as archive:
        for name, data in files.items():
            archive.writestr(name, data)
    return output.getvalue()


class DesktopValidationTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        self.profile = json.loads(desktop.PROFILE.read_text())
        self.selection = {'schemaVersion': 1, 'version': '0.3.0', 'sourceRepository': self.profile['sourceRepository'],
                          'sourceCommit': 'a' * 40, 'sourceRunId': 123, 'sourceRunAttempt': 1,
                          'sourceWorkflow': 'neoko-terminal-desktop.yml', 'sourceEvent': 'push',
                          'sourceRef': 'refs/tags/neoko-terminal-desktop-v0.3.0', 'artifacts': []}
        self.contents = {}
        for index, target in enumerate(desktop.TARGETS):
            stem = f'neoko-terminal-0.3.0-{target}'
            package = stem + ('.deb' if target.endswith('linux-gnu') else '.zip')

            info = {'desktop_version': '0.3.0', 'crate_version': '0.2.0', 'target': target, 'source_sha': 'a' * 40,
                    'source_dirty': False, 'nsh_revision': self.profile['nshRevision'],
                    'signing': 'ad-hoc; not notarized' if target.endswith('apple-darwin') else 'unsigned',
                    'cargo_binary_sha256': 'b' * 64}
            if target.endswith('linux-gnu'):
                info['build_runtime_versions'] = {'libc6': '2.39', 'gtk4': '4.14.2', 'glib': '2.80.0', 'gstreamer': '1.24.2'}
            data = package_fixture(target, info)
            self.contents[target] = {package: data, package + '.sha256': f'{hashlib.sha256(data).hexdigest()}  {package}\n'.encode(),
                                     stem + '.build-info.json': json.dumps(info).encode()}
            self.selection['artifacts'].append({'target': target, 'artifactId': index + 1,
                                               'artifactName': f'neoko-terminal-desktop-0.3.0-{target}'})
            self.archive(target)

    def archive(self, target, entries=None):
        filename = self.root / (target + '.zip')
        with warnings.catch_warnings(), zipfile.ZipFile(filename, 'w') as archive:
            warnings.simplefilter('ignore', UserWarning)
            for name, data in (entries if entries is not None else self.contents[target].items()):
                archive.writestr(name, data)
        artifact = next(a for a in self.selection['artifacts'] if a['target'] == target)
        artifact.update(artifactSize=filename.stat().st_size,
                        artifactDigest='sha256:' + hashlib.sha256(filename.read_bytes()).hexdigest())
        return filename

    def prepare(self):
        return desktop.prepare(self.root, self.selection, self.profile)

    def test_exact_four_archives_promote_only_twelve_files_and_bind_selection_and_profile(self):
        result = self.prepare()
        self.assertEqual(len(result['files']), 12)
        self.assertEqual(result['selection'], self.selection)
        self.assertEqual(result['profile'], self.profile)
        self.assertEqual(set(result['files']), {p.name for p in (self.root / 'verified').iterdir()})
        for name, digest in result['files'].items():
            self.assertEqual(hashlib.sha256((self.root / 'verified' / name).read_bytes()).hexdigest(), digest)

    def test_zstd_deb_tar_members_pass_full_preparation(self):
        target = desktop.TARGETS[0]
        name = next(n for n in self.contents[target] if n.endswith('.json'))
        info = json.loads(self.contents[target][name])
        package = next(n for n in self.contents[target] if n.endswith('.deb'))
        data = package_fixture(target, info, compression='zst')
        self.assertIn(b'control.tar.zst', data)
        self.assertIn(b'data.tar.zst', data)
        self.contents[target].update({name: json.dumps(info).encode(), package: data,
                                     package + '.sha256': f'{hashlib.sha256(data).hexdigest()}  {package}\n'.encode()})
        self.archive(target)
        result = self.prepare()
        self.assertEqual(len(result['files']), 12)
        self.assertEqual((self.root / 'verified' / package).read_bytes(), data)

    def test_opaque_packages_with_valid_outer_digest_checksum_and_provenance_fail(self):
        for target in desktop.TARGETS:
            name = next(n for n in self.contents[target] if n.endswith(('.deb', '.zip')))
            original = dict(self.contents[target])
            self.contents[target][name] = b'opaque package with matching outer guards'
            self.contents[target][name + '.sha256'] = f'{hashlib.sha256(self.contents[target][name]).hexdigest()}  {name}\n'.encode()
            self.archive(target)
            with self.subTest(target=target), self.assertRaises((ValueError, zipfile.BadZipFile)):
                self.prepare()
            self.assertFalse((self.root / 'verified').exists())
            self.assertFalse((self.root / 'verification.json').exists())
            self.contents[target] = original
            self.archive(target)

    def test_wrong_crate_version_even_with_matching_inner_metadata_fails(self):
        target = desktop.TARGETS[0]
        name = next(n for n in self.contents[target] if n.endswith('.json'))
        info = json.loads(self.contents[target][name])
        info['crate_version'] = '99.99.99'
        package = next(n for n in self.contents[target] if n.endswith('.deb'))
        data = package_fixture(target, info)
        self.contents[target].update({name: json.dumps(info).encode(), package: data,
                                     package + '.sha256': f'{hashlib.sha256(data).hexdigest()}  {package}\n'.encode()})
        self.archive(target)
        with self.assertRaisesRegex(ValueError, 'crate|provenance'):
            self.prepare()
        self.assertFalse((self.root / 'verified').exists())
        self.assertFalse((self.root / 'verification.json').exists())

    def test_missing_or_duplicate_target_ids_fail_before_promotion(self):
        for change in ['missing', 'duplicate', 'reordered']:
            original = list(self.selection['artifacts'])
            if change == 'missing':
                self.selection['artifacts'] = original[:-1]
            elif change == 'duplicate':
                self.selection['artifacts'] = [original[0]] * 4
            else:
                self.selection['artifacts'] = list(reversed(original))
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.prepare()
            self.assertFalse((self.root / 'verified').exists())
            self.selection['artifacts'] = original

    def test_forged_source_workflow_tag_event_commit_and_run_identity_fail(self):
        changes = {'sourceRepository': 'attacker/fork', 'sourceWorkflow': 'neoko-terminal-android.yml',
                   'sourceRef': 'refs/tags/remoted-client-desktop-v0.3.0', 'sourceEvent': 'pull_request',
                   'sourceCommit': 'main', 'sourceRunId': True, 'sourceRunAttempt': 0, 'schemaVersion': True}
        original = self.selection.copy()
        for field, value in changes.items():
            self.selection = {**original, field: value}
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.prepare()
        self.selection = original

    def test_archive_digest_or_size_mismatch_fails(self):
        artifact = self.selection['artifacts'][0]
        for field, value in [('artifactDigest', 'sha256:' + '0' * 64), ('artifactSize', 1)]:
            old = artifact[field]
            artifact[field] = value
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'digest/size'):
                self.prepare()
            artifact[field] = old

    def test_extra_source_duplicate_nested_and_symlink_entries_fail(self):
        target = desktop.TARGETS[0]
        entries = list(self.contents[target].items())
        link = zipfile.ZipInfo(entries[-1][0]); link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        cases = [entries + [('source.rs', b'private')], entries[:-1] + [entries[0]],
                 entries[:-1] + [('../' + entries[-1][0], entries[-1][1])], entries[:-1] + [(link, b'elsewhere')]]
        for altered in cases:
            self.archive(target, altered)
            with self.assertRaises(ValueError):
                self.prepare()
            self.assertFalse((self.root / 'verified').exists())

    def test_windows_crlf_checksum_passes_full_preparation(self):
        target = desktop.TARGETS[1]
        name = next(n for n in self.contents[target] if n.endswith('.sha256'))
        self.contents[target][name] = self.contents[target][name].replace(b'\n', b'\r\n')
        self.archive(target)
        result = self.prepare()
        self.assertEqual(len(result['files']), 12)
        self.assertEqual((self.root / 'verified' / name).read_bytes(), self.contents[target][name])

    def test_checksum_crlf_compatibility_rejects_other_changes(self):
        for target in desktop.TARGETS[:2]:
            name = next(n for n in self.contents[target] if n.endswith('.sha256'))
            original = self.contents[target][name]
            cases = [original + b'\n', original.replace(b'  ', b' '), original.rstrip(b'\n') + b' \r\n',
                     original + b'extra-file\n', b'0' * 64 + original[64:]]
            if target.endswith('linux-gnu'):
                cases.append(original.replace(b'\n', b'\r\n'))
            for altered in cases:
                self.contents[target][name] = altered
                self.archive(target)
                with self.subTest(target=target, checksum=altered), self.assertRaisesRegex(ValueError, 'checksum'):
                    self.prepare()
                self.assertFalse((self.root / 'verified').exists())
            self.contents[target][name] = original
            self.archive(target)

    def test_package_checksum_mismatch_fails(self):
        target = desktop.TARGETS[0]
        name = next(n for n in self.contents[target] if n.endswith('.sha256'))
        self.contents[target][name] = b'0' * 64 + b'  wrong.deb\n'
        self.archive(target)
        with self.assertRaisesRegex(ValueError, 'checksum'):
            self.prepare()

    def test_build_provenance_rejects_wrong_target_source_dirty_version_nsh_and_signing(self):
        target = desktop.TARGETS[-1]
        name = next(n for n in self.contents[target] if n.endswith('.json'))
        info = json.loads(self.contents[target][name])
        for field, value in [('target', desktop.TARGETS[0]), ('source_sha', 'f' * 40), ('source_dirty', True),
                             ('source_dirty', 0), ('desktop_version', '0.3.1'), ('nsh_revision', 'f' * 40),
                             ('signing', 'notarized'), ('cargo_binary_sha256', 'bad'), ('privateKey', 'secret')]:
            self.contents[target][name] = json.dumps({**info, field: value}).encode()
            self.archive(target)
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                self.prepare()
            self.assertFalse((self.root / 'verified').exists())
            self.assertFalse((self.root / 'verification.json').exists())

    def test_duplicate_provenance_json_fields_fail(self):
        target = desktop.TARGETS[-1]
        name = next(n for n in self.contents[target] if n.endswith('.json'))
        self.contents[target][name] = self.contents[target][name][:-1] + b',"source_dirty":false}'
        self.archive(target)
        with self.assertRaisesRegex(ValueError, 'Duplicate JSON'):
            self.prepare()

    def test_bounded_archive_package_and_metadata_expansion_fail(self):
        for field in ['maxArchiveBytes', 'maxPackageBytes', 'maxMetadataBytes']:
            old = self.profile[field]; self.profile[field] = 1
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'bound|artifact selection'):
                self.prepare()
            self.profile[field] = old

    def test_validated_outputs_cannot_be_replaced(self):
        self.prepare()
        with self.assertRaisesRegex(ValueError, 'already exists'):
            self.prepare()


if __name__ == '__main__':
    unittest.main()

import hashlib
import importlib.util
import io
import json
from pathlib import Path
import stat
import sys
import tempfile
import unittest
import warnings
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('native', ROOT / 'scripts/prepare-neoko-terminal.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class NativeValidationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='.native-test-', dir=ROOT)
        self.addCleanup(self.directory.cleanup)
        self.directory = Path(self.directory.name)
        self.profile = json.loads(native.PROFILE.read_text())
        self.apk_name = 'neoko-terminal-v0.1.0-android-arm64.apk'
        self.apk = self.make_apk()
        self.apk_sha = hashlib.sha256(self.apk).hexdigest()
        self.selection = {
            'schemaVersion': 1, 'version': '0.1.0', 'sourceRepository': self.profile['sourceRepository'],
            'sourceCommit': 'a' * 40, 'sourceRunId': 123, 'sourceRunAttempt': 1,
            'sourceWorkflow': 'neoko-terminal-android.yml', 'sourceEvent': 'push',
            'sourceRef': 'refs/tags/neoko-terminal-android-v0.1.0', 'artifactId': 456,
            'artifactName': 'neoko-terminal-android-v0.1.0',
        }
        self.manifest = {
            'schemaVersion': 1, 'component': 'neoko-terminal', 'version': '0.1.0', 'protocolVersion': 1,
            **{key: self.selection[key] for key in native.SOURCE_FIELDS if key != 'version'},
            'apkName': self.apk_name, 'apkSha256': self.apk_sha, 'apkSize': len(self.apk),
            'packageName': 'community.lazycat.neko.remoted', 'versionCode': 1, 'abi': 'arm64-v8a',
            'signingCertificateSha256': self.profile['signingCertificateSha256'],
            'minSdk': 28, 'targetSdk': 35, 'debuggable': False,
        }

    def make_apk(self, abi='arm64-v8a', machine=183, extra=()):
        stream = io.BytesIO()
        header = bytearray(64)
        header[:6] = b'\x7fELF\x02\x01'
        header[18:20] = machine.to_bytes(2, 'little')
        with zipfile.ZipFile(stream, 'w') as archive:
            archive.writestr('AndroidManifest.xml', b'manifest')
            archive.writestr('classes.dex', b'dex')
            archive.writestr(f'lib/{abi}/libapp.so', header)
            for name, content in extra:
                archive.writestr(name, content)
        return stream.getvalue()

    def artifact(self, extra=(), manifest=None, checksum=None, apk=None, special=None):
        filename = self.directory / 'artifact.zip'
        with warnings.catch_warnings(), zipfile.ZipFile(filename, 'w') as archive:
            warnings.simplefilter('ignore', UserWarning)
            archive.writestr(self.apk_name, apk if apk is not None else self.apk)
            archive.writestr('checksums.txt', checksum if checksum is not None else f'{self.apk_sha}  {self.apk_name}\n')
            archive.writestr(special if special is not None else 'provenance.json',
                             json.dumps(self.manifest if manifest is None else manifest))
            for name, content in extra:
                archive.writestr(name, content)
        self.selection['artifactDigest'] = 'sha256:' + hashlib.sha256(filename.read_bytes()).hexdigest()
        self.selection['artifactSize'] = filename.stat().st_size
        return filename

    def prepare(self, filename=None, inspector=None):
        return native.prepare(filename or self.artifact(), self.selection, self.profile,
                              self.directory / 'verified', 'aapt', 'apksigner',
                              inspect=inspector or (lambda *args: None))

    def test_exact_valid_artifact_prepares_three_files_and_bound_evidence(self):
        result = self.prepare()
        self.assertEqual(set(result['files']), {self.apk_name, 'checksums.txt', 'provenance.json'})
        self.assertEqual(result['selection'], self.selection)
        self.assertEqual(sorted(path.name for path in (self.directory / 'verified').iterdir()), sorted(result['files']))

    def test_missing_or_placeholder_signing_pin_fails_closed(self):
        for value in (None, '', '0' * 64, 'A' * 64):
            with self.subTest(value=value):
                profile = {**self.profile, 'signingCertificateSha256': value}
                with self.assertRaisesRegex(ValueError, 'must be pinned'):
                    native.validate_profile(profile)

    def test_renamed_contract_preserves_package_and_certificate(self):
        self.assertEqual(self.profile['component'], 'neoko-terminal')
        self.assertEqual(self.profile['name'], 'neoko-terminal')
        self.assertEqual(self.profile['packageName'], 'community.lazycat.neko.remoted')
        self.assertEqual(self.profile['signingCertificateSha256'],
                         '6e2df6d3940b6898cb749365015483c52d40c2991995ab47333c03328b142e8e')
        for field, value in [('component', 'remoted-client'), ('sourceWorkflow', 'remoted-client.yml'),
                             ('sourceWorkflow', 'neoko-terminal-desktop.yml'),
                             ('tagPrefix', 'remoted-client-v'), ('tagPrefix', 'neoko-terminal-desktop-v'),
                             ('artifactPrefix', 'remoted-client-native-v')]:
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                native.validate_profile({**self.profile, field: value})

    def test_old_provenance_and_desktop_sources_are_rejected(self):
        for field, value in [('component', 'remoted-client'), ('sourceWorkflow', 'remoted-client.yml'),
                             ('sourceWorkflow', 'neoko-terminal-desktop.yml'),
                             ('sourceRef', 'refs/tags/remoted-client-v0.1.0'),
                             ('sourceRef', 'refs/tags/neoko-terminal-desktop-v0.1.0')]:
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                self.prepare(self.artifact(manifest={**self.manifest, field: value}))

    def test_old_apk_name_is_rejected_even_with_consistent_manifest_and_checksum(self):
        self.apk_name = 'neko-remoted-client-v0.1.0-android-arm64.apk'
        self.manifest['apkName'] = self.apk_name
        with self.assertRaisesRegex(ValueError, 'exactly APK'):
            self.prepare(self.artifact())

    def test_extra_private_source_or_signing_files_are_rejected(self):
        for name in ('Cargo.toml', 'private.p12', 'source.rs', '.env', '../secret', '/secret', 'nested/a.apk', 'a\\b'):
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'exactly APK|entry count'):
                self.prepare(self.artifact(extra=[(name, b'secret')]))

    def test_duplicate_artifact_entry_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'exactly APK|entry count'):
            self.prepare(self.artifact(extra=[('checksums.txt', b'wrong')]))

    def test_symlink_entry_is_rejected_without_following(self):
        info = zipfile.ZipInfo('provenance.json')
        info.create_system = 3
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        with self.assertRaisesRegex(ValueError, 'symlink'):
            self.prepare(self.artifact(special=info))

    def test_github_archive_digest_is_independently_required(self):
        filename = self.artifact()
        self.selection['artifactDigest'] = 'sha256:' + '0' * 64
        with self.assertRaisesRegex(ValueError, 'archive digest'):
            self.prepare(filename)

    def test_directory_counts_and_appended_content_fail_before_zip_materialization(self):
        filename = self.artifact()
        with filename.open('ab') as output:
            output.write(b'hidden content')
        with self.assertRaisesRegex(ValueError, 'trailing content'):
            native.zip_directory_guard(filename, 3)

    def test_checksum_cannot_list_other_files_or_claim_another_hash(self):
        for checksum in ('0' * 64 + f'  {self.apk_name}\n', f'{self.apk_sha}  {self.apk_name}\nsource.rs\n'):
            with self.subTest(checksum=checksum), self.assertRaisesRegex(ValueError, 'Checksum'):
                self.prepare(self.artifact(checksum=checksum))

    def test_source_workflow_commit_run_attempt_event_version_and_key_are_bound(self):
        changes = {'sourceRepository': 'attacker/fork', 'sourceCommit': 'b' * 40, 'sourceRunId': 999,
                   'sourceRunAttempt': 2, 'sourceWorkflow': 'pull-request.yml', 'sourceEvent': 'pull_request',
                   'sourceRef': 'refs/heads/main', 'version': '0.1.1', 'apkSha256': '0' * 64,
                   'apkSize': 999, 'packageName': 'wrong.app', 'abi': 'x86_64', 'versionCode': True,
                   'protocolVersion': 2, 'debuggable': True, 'signingCertificateSha256': 'f' * 64,
                   'minSdk': 27, 'targetSdk': 34, 'apkName': 'other.apk'}
        for field, value in changes.items():
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.prepare(self.artifact(manifest={**self.manifest, field: value}))

    def test_unknown_and_duplicate_manifest_keys_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'schema fields'):
            self.prepare(self.artifact(manifest={**self.manifest, 'privateKey': 'secret'}))
        with self.assertRaisesRegex(ValueError, 'Duplicate JSON'):
            native.read_json('{"version":"0.1.0","version":"0.1.1"}')

    def test_archive_and_apk_expansion_bounds_are_enforced(self):
        filename = self.artifact()
        self.profile['maxArchiveBytes'] = 1
        with self.assertRaisesRegex(ValueError, 'archive exceeds'):
            self.prepare(filename)
        self.profile['maxArchiveBytes'] = 268435456
        self.profile['maxApkExpandedBytes'] = 1
        with self.assertRaisesRegex(ValueError, 'expanded content'):
            self.prepare(filename)

    def test_wrong_abi_native_binary_and_duplicate_apk_entries_fail(self):
        for apk in (self.make_apk(abi='x86_64'), self.make_apk(machine=62),
                    self.make_apk(extra=[('../escape', b'x')]), self.make_apk(extra=[('classes.dex', b'duplicate')])):
            with self.subTest(apk=hashlib.sha256(apk).hexdigest()), self.assertRaises(ValueError):
                filename = self.directory / 'bad.apk'
                filename.write_bytes(apk)
                native.inspect_apk_zip(filename, self.profile)

    def test_signature_inspection_failure_does_not_promote_outputs(self):
        def reject(*args):
            raise ValueError('Signature rejected')
        with self.assertRaisesRegex(ValueError, 'Signature rejected'):
            self.prepare(inspector=reject)
        self.assertFalse((self.directory / 'verified').exists())
        self.assertFalse((self.directory / 'verification.json').exists())

    def test_android_metadata_and_actual_signature_are_not_trusted_from_provenance(self):
        badging = "package: name='community.lazycat.neko.remoted' versionCode='1' versionName='0.1.0'\nsdkVersion:'28'\ntargetSdkVersion:'35'\nnative-code: 'arm64-v8a'\n"
        certificate = f"Verifies\nSigner #1 certificate SHA-256 digest: {self.profile['signingCertificateSha256']}\n"
        native.inspect_android('app.apk', self.manifest, self.profile, 'aapt', 'apksigner', run=lambda command: badging if command[0] == 'aapt' else certificate)
        for output in (badging.replace("versionCode='1'", "versionCode='2'"), badging + 'application-debuggable\n',
                       badging.replace("'arm64-v8a'", "'arm64-v8a' 'x86_64'"), badging.replace("sdkVersion:'28'", "sdkVersion:'27'")):
            with self.subTest(output=output), self.assertRaises(ValueError):
                native.inspect_android('app.apk', self.manifest, self.profile, 'aapt', 'apksigner', run=lambda command: output if command[0] == 'aapt' else certificate)
        for output in (certificate.replace(self.profile['signingCertificateSha256'], 'f' * 64), certificate + 'Signer #2 certificate SHA-256 digest: ' + 'f' * 64 + '\n', certificate + 'Signer #1 certificate DN: CN=Android Debug\n'):
            with self.subTest(output=output), self.assertRaises(ValueError):
                native.inspect_android('app.apk', self.manifest, self.profile, 'aapt', 'apksigner', run=lambda command: badging if command[0] == 'aapt' else output)

    def test_tool_output_is_bounded_and_failed_tool_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'output exceeds'):
            native.tool_output([sys.executable, '-c', 'import sys;sys.stdout.write("x"*1100000)'])
        with self.assertRaisesRegex(ValueError, 'verification failed'):
            native.tool_output([sys.executable, '-c', 'raise SystemExit(1)'])


if __name__ == '__main__':
    unittest.main()

import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('native_artifact', Path(__file__).with_name('native-artifact.py'))
producer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(producer)


class ArtifactContractTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        (self.root / 'client/android').mkdir(parents=True)
        (self.root / 'client/Cargo.toml').write_text('[package]\nversion="0.1.0"\n')
        (self.root / 'client/nsh.json').write_text(json.dumps({'version': '0.1.0', 'build': 1}))
        (self.root / 'client/android/AndroidManifest.xml').write_text(
            '<manifest xmlns:android="http://schemas.android.com/apk/res/android" android:versionCode="1" android:versionName="0.1.0"/>')
        self.root_patch = patch.object(producer, 'ROOT', self.root)
        self.root_patch.start()
        self.environment = patch.dict(os.environ, {'RELEASE_REF': 'refs/tags/remoted-client-v0.1.0'})
        self.environment.start()

    def tearDown(self):
        self.environment.stop()
        self.root_patch.stop()
        self.temporary.cleanup()

    def test_rejects_branch_app_tag_and_mismatched_native_tag(self):
        self.assertEqual(producer.version(), ('0.1.0', 1))
        for ref in ['refs/heads/main', 'refs/tags/v0.1.0', 'refs/tags/remoted-client-v0.2.0']:
            with self.subTest(ref=ref), patch.dict(os.environ, {'RELEASE_REF': ref}):
                with self.assertRaises(ValueError):
                    producer.version()

    def test_rejects_manifest_version_and_update_code_drift(self):
        for contents in [{'version': '0.1.1', 'build': 1}, {'version': '0.1.0', 'build': 2}]:
            with self.subTest(contents=contents):
                (self.root / 'client/nsh.json').write_text(json.dumps(contents))
                with self.assertRaises(ValueError):
                    producer.version()

    def test_rejects_untrusted_repository_before_reading_payload(self):
        with patch.dict(os.environ, {
            'SOURCE_REPOSITORY': 'untrusted/fork', 'SOURCE_COMMIT': 'a' * 40,
            'SOURCE_RUN_ID': '1', 'SOURCE_RUN_ATTEMPT': '1', 'SOURCE_EVENT': 'push',
        }):
            with self.assertRaisesRegex(ValueError, 'source identity'):
                producer.package()

    def test_rejects_pr_event_before_reading_payload(self):
        with patch.dict(os.environ, {
            'SOURCE_REPOSITORY': 'ca-x/lazycat-neko-webshell', 'SOURCE_COMMIT': 'a' * 40,
            'SOURCE_RUN_ID': '1', 'SOURCE_RUN_ATTEMPT': '1', 'SOURCE_EVENT': 'pull_request',
        }):
            with self.assertRaisesRegex(ValueError, 'build event'):
                producer.package()


if __name__ == '__main__':
    unittest.main()

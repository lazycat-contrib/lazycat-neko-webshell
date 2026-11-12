#!/usr/bin/env python3
"""Build a minimal release artifact after the Android verifier has succeeded."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tomllib
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
ANDROID = '{http://schemas.android.com/apk/res/android}'


def version():
    cargo = tomllib.loads((ROOT / 'client/Cargo.toml').read_text())
    config = json.loads((ROOT / 'client/nsh.json').read_text())
    manifest = ET.parse(ROOT / 'client/android/AndroidManifest.xml').getroot()
    result = cargo['package']['version']
    if not re.fullmatch(r'\d+\.\d+\.\d+', result):
        raise ValueError('Native version must be a stable SemVer')
    if config['version'] != result or manifest.attrib[ANDROID + 'versionName'] != result:
        raise ValueError('Native Cargo, NSH and Android versions differ')
    if int(manifest.attrib[ANDROID + 'versionCode']) != config['build']:
        raise ValueError('Native build numbers differ')
    if os.environ.get('RELEASE_REF') != 'refs/tags/neoko-terminal-android-v' + result:
        raise ValueError('Build must use the matching remoted-client release tag')
    return result, config['build']


def package():
    release, build = version()
    source = {
        'repository': os.environ['SOURCE_REPOSITORY'],
        'commit': os.environ['SOURCE_COMMIT'],
        'workflow': 'neoko-terminal-android.yml',
        'runId': int(os.environ['SOURCE_RUN_ID']),
        'runAttempt': int(os.environ['SOURCE_RUN_ATTEMPT']),
        'event': os.environ['SOURCE_EVENT'],
        'ref': os.environ['RELEASE_REF'],
    }
    if source['repository'] != 'ca-x/lazycat-neko-webshell' or not re.fullmatch(r'[0-9a-f]{40}', source['commit']):
        raise ValueError('Unexpected source identity')
    if source['event'] not in ('push', 'workflow_dispatch') or min(source['runId'], source['runAttempt']) < 1:
        raise ValueError('Unexpected build event')
    output = ROOT / 'client/target/android-app'
    info = json.loads((output / 'build-info.json').read_text())
    apk = output / 'neko-remoted.apk'
    sha = hashlib.file_digest(apk.open('rb'), 'sha256').hexdigest()
    if sha != info['apk_sha256'] or not info['zip_alignment_verified'] or info['elf_load_alignment_min'] < 16384:
        raise ValueError('Android verification evidence differs from payload')
    certificate = info['certificate_sha256'].lower()
    if not re.fullmatch(r'[0-9a-f]{64}', certificate):
        raise ValueError('Invalid signing certificate fingerprint')
    destination = ROOT / 'dist/native'
    if destination.exists():
        shutil.rmtree(destination)
    destination.mkdir(parents=True)
    name = f'neoko-terminal-v{release}-android-arm64.apk'
    shutil.copyfile(apk, destination / name)
    provenance = {
        'schemaVersion': 1, 'component': 'neoko-terminal',
        'version': release, 'protocolVersion': 1,
        'sourceRepository': source['repository'], 'sourceCommit': source['commit'],
        'sourceRunId': source['runId'], 'sourceRunAttempt': source['runAttempt'],
        'sourceWorkflow': source['workflow'], 'sourceEvent': source['event'],
        'sourceRef': source['ref'], 'apkName': name, 'apkSha256': sha,
        'apkSize': apk.stat().st_size, 'packageName': 'community.lazycat.neko.remoted',
        'versionCode': build, 'abi': 'arm64-v8a',
        'signingCertificateSha256': certificate,
        'minSdk': 28, 'targetSdk': 35, 'debuggable': False,
    }
    (destination / 'checksums.txt').write_text(f'{sha}  {name}\n')
    (destination / 'provenance.json').write_text(json.dumps(provenance, ensure_ascii=False, indent=2) + '\n')
    print(f'Prepared native artifact {release}: {sha}')


if __name__ == '__main__':
    if sys.argv[1:] == ['version']:
        release, _ = version()
        with open(os.environ['GITHUB_OUTPUT'], 'a') as handle:
            handle.write(f'version={release}\n')
    elif sys.argv[1:] == ['package']:
        package()
    else:
        raise SystemExit('Usage: native-artifact.py version|package')

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {isDeepStrictEqual} = require('node:util');
const native = require('./neoko-terminal.cjs');
const root = path.resolve(__dirname, '..');
const work = path.join(root, 'dist/neoko-terminal-desktop');
const stableVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const sha40 = /^[0-9a-f]{40}$/;
const sha256 = /^[0-9a-f]{64}$/;
const positive = value => Number.isSafeInteger(value) && value > 0;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const nativeBuildInputs = Object.freeze({
  ghostty_source_revision: '108cacb17ed8990840cd14abfce43d8ed8503ca1',
  ghostty_wrapper_revision: 'cd4d497e8c698b27054a677ce19d1bd1a1a4d8bf',
  zig_version: '0.17.1',
});
const targets = ['x86_64-unknown-linux-gnu', 'x86_64-pc-windows-msvc', 'aarch64-apple-darwin', 'x86_64-apple-darwin'];
function ensure(value, message) { if (!value) throw new Error(message); }
function validateProfile(profile) {
  ensure(profile.component === 'neoko-terminal' && profile.sourceRepository === 'ca-x/lazycat-neko-webshell' &&
    profile.publicRepository === 'lazycat-contrib/lazycat-neko-webshell' && profile.sourceWorkflow === 'neoko-terminal-desktop.yml' &&
    profile.tagPrefix === 'neoko-terminal-desktop-v' && profile.artifactPrefix === 'neoko-terminal-desktop-' &&
    profile.crateVersion === '0.4.3' && isDeepStrictEqual(profile.nativeBuildInputs, nativeBuildInputs) &&
    profile.packageName === 'community.lazycat.neko.remoted' && sha40.test(profile.nshRevision) &&
    isDeepStrictEqual(profile.targets, targets), 'Unexpected desktop source profile');
  for (const key of ['maxArchiveBytes', 'maxPackageBytes', 'maxMetadataBytes']) {
    ensure(positive(profile[key]) && profile[key] <= 1024 ** 3, 'Invalid desktop content bound');
  }
}
function loadProfile() {
  const profile = JSON.parse(fs.readFileSync(path.join(root, 'components/neoko-terminal/desktop-profile.json'), 'utf8'));
  validateProfile(profile);
  return profile;
}
function validateSelection(selection, profile) {
  ensure(selection.schemaVersion === 1 && stableVersion.test(selection.version) && sha40.test(selection.sourceCommit) &&
    positive(selection.sourceRunId) && positive(selection.sourceRunAttempt) && selection.sourceRepository === profile.sourceRepository &&
    selection.sourceWorkflow === profile.sourceWorkflow && ['push', 'workflow_dispatch'].includes(selection.sourceEvent) &&
    selection.sourceRef === 'refs/tags/' + profile.tagPrefix + selection.version &&
    Array.isArray(selection.artifacts) && selection.artifacts.length === targets.length, 'Invalid desktop source selection');
  ensure(new Set(selection.artifacts.map(a => a.artifactId)).size === targets.length, 'Duplicate desktop artifact ID');
  for (const [index, target] of targets.entries()) {
    const artifact = selection.artifacts[index];
    ensure(artifact.target === target && artifact.artifactName === `${profile.artifactPrefix}${selection.version}-${target}` &&
      positive(artifact.artifactId) && positive(artifact.artifactSize) && artifact.artifactSize <= profile.maxArchiveBytes &&
      /^sha256:[0-9a-f]{64}$/.test(artifact.artifactDigest || ''), 'Invalid desktop artifact selection');
  }
}
async function selectSource({github, version, commit, runID, profile = loadProfile()}) {
  validateProfile(profile);
  ensure(stableVersion.test(version || '') && sha40.test(commit || '') && /^[1-9]\d*$/.test(String(runID)) && positive(Number(runID)),
    'Explicit desktop version, source commit and run ID are required');
  runID = Number(runID);
  const [owner, repo] = profile.sourceRepository.split('/');
  const repository = (await github.rest.repos.get({owner, repo})).data;
  const workflow = (await github.rest.actions.getWorkflow({owner, repo, workflow_id: profile.sourceWorkflow})).data;
  const run = (await github.rest.actions.getWorkflowRun({owner, repo, run_id: runID})).data;
  native.validateRun(run, repository, workflow, version, commit, runID, profile);
  ensure(await native.tagCommit(github, owner, repo, profile.tagPrefix + version) === commit, 'Desktop source tag moved or differs from run headSHA');
  const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, {owner, repo, run_id: runID, per_page: 100});
  ensure(artifacts.length === targets.length, 'Expected exactly four desktop target artifacts');
  const selected = targets.map(target => {
    const name = `${profile.artifactPrefix}${version}-${target}`;
    const matches = artifacts.filter(artifact => artifact.name === name);
    ensure(matches.length === 1, 'Missing, duplicate or unexpected desktop target artifact');
    const artifact = matches[0];
    ensure(artifact.expired === false && Number.isFinite(Date.parse(artifact.expires_at)) && Date.parse(artifact.expires_at) > Date.now(), 'Desktop artifact expired');
    ensure(artifact.workflow_run?.id === runID && artifact.workflow_run?.head_sha === commit &&
      artifact.workflow_run?.repository_id === repository.id && artifact.workflow_run?.head_repository_id === repository.id &&
      artifact.workflow_run?.head_branch === profile.tagPrefix + version, 'Desktop artifact source identity differs');
    return {target, artifactId: artifact.id, artifactName: name, artifactDigest: artifact.digest, artifactSize: artifact.size_in_bytes};
  });
  const selection = {schemaVersion: 1, version, sourceRepository: profile.sourceRepository, sourceCommit: commit,
    sourceRunId: runID, sourceRunAttempt: run.run_attempt, sourceWorkflow: profile.sourceWorkflow,
    sourceEvent: run.event, sourceRef: 'refs/tags/' + profile.tagPrefix + version, artifacts: selected};
  validateSelection(selection, profile);
  return selection;
}
async function selectAndDownload({github, core}) {
  const profile = loadProfile();
  const selection = await selectSource({github, version: process.env.NATIVE_VERSION, commit: process.env.SOURCE_COMMIT, runID: process.env.SOURCE_RUN_ID, profile});
  for (const artifact of selection.artifacts) {
    await native.downloadArtifactArchive({selection: {...artifact, sourceRepository: selection.sourceRepository}, profile,
      token: process.env.SOURCE_REPO_TOKEN, output: path.join(work, artifact.target + '.zip')});
  }
  fs.writeFileSync(path.join(work, 'selection.json'), JSON.stringify(selection) + '\n', {flag: 'wx', mode: 0o600});
  core.notice(`Selected four private desktop artifacts from run ${selection.sourceRunId}, commit ${selection.sourceCommit}`);
}
async function revalidateSource({github, directory = work}) {
  const selection = JSON.parse(fs.readFileSync(path.join(directory, 'selection.json'), 'utf8'));
  const current = await selectSource({github, version: selection.version, commit: selection.sourceCommit, runID: selection.sourceRunId});
  ensure(isDeepStrictEqual(current, selection), 'Desktop source run/artifacts changed after validation');
}
function expectedFiles(version, profile) {
  return profile.targets.flatMap(target => {
    const stem = `neoko-terminal-${version}-${target}`;
    const filename = stem + (target.endsWith('linux-gnu') ? '.deb' : '.zip');
    return [filename, filename + '.sha256', stem + '.build-info.json'];
  }).sort();
}
function verifiedFiles(profile = loadProfile(), directory = work) {
  validateProfile(profile);
  const selection = JSON.parse(fs.readFileSync(path.join(directory, 'selection.json'), 'utf8'));
  validateSelection(selection, profile);
  const marker = JSON.parse(fs.readFileSync(path.join(directory, 'verification.json'), 'utf8'));
  ensure(marker.schemaVersion === 1 && isDeepStrictEqual(marker.selection, selection) && isDeepStrictEqual(marker.profile, profile),
    'Desktop verification evidence differs from source/profile');
  const expected = expectedFiles(selection.version, profile);
  ensure(marker.files && isDeepStrictEqual(Object.keys(marker.files).sort(), expected) &&
    isDeepStrictEqual(fs.readdirSync(path.join(directory, 'verified')).sort(), expected), 'Desktop verified output must contain exactly twelve release files');
  const files = expected.map(name => {
    const filename = path.join(directory, 'verified', name);
    const stat = fs.lstatSync(filename);
    const limit = name.endsWith('.json') || name.endsWith('.sha256') ? profile.maxMetadataBytes : profile.maxPackageBytes;
    ensure(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size > 0 && stat.size <= limit, 'Invalid desktop verified file identity/size');
    const bytes = fs.readFileSync(filename);
    ensure(sha256.test(marker.files[name]) && hash(bytes) === marker.files[name], 'Desktop verified file changed before publication');
    return {name, bytes, sha256: marker.files[name]};
  });
  return {selection, files};
}
async function publishRelease({github, context, core, dryRun = true, releaseCommit = context.sha, profile = loadProfile(), directory = work}) {
  const {selection, files} = verifiedFiles(profile, directory);
  return native.publishVerifiedRelease({github, context, core, dryRun, releaseCommit, profile, selection, files,
    body: `neoko-terminal desktop ${selection.version}.\n\nSource: ${selection.sourceRepository}@${selection.sourceCommit}\nPrivate build: ${selection.sourceRunId} (attempt ${selection.sourceRunAttempt}).\n\nFour target packages, checksums and build provenance. Windows/Linux are unsigned; macOS uses ad-hoc signing and is not notarized.`,
  });
}
module.exports = {loadProfile, validateProfile, validateSelection, selectSource, selectAndDownload, revalidateSource, expectedFiles, verifiedFiles, publishRelease};

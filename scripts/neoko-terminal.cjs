const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {isDeepStrictEqual} = require('node:util');

const root = path.resolve(__dirname, '..');
const work = path.join(root, 'dist/neoko-terminal');
const stableVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const sha40 = /^[0-9a-f]{40}$/;
const sha256 = /^[0-9a-f]{64}$/;
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function ensure(value, message) { if (!value) throw new Error(message); }

function loadProfile() {
  const profile = JSON.parse(fs.readFileSync(path.join(root, 'components/neoko-terminal/profile.json'), 'utf8'));
  validateProfile(profile);
  return profile;
}
function validateProfile(profile) {
  ensure(profile.component === 'neoko-terminal' && profile.tagPrefix === 'neoko-terminal-android-v' &&
    profile.artifactPrefix === 'neoko-terminal-android-v' && profile.sourceWorkflow === 'neoko-terminal-android.yml', 'Unexpected native component profile');
  ensure(profile.sourceRepository === 'ca-x/lazycat-neko-webshell' && profile.publicRepository === 'lazycat-contrib/lazycat-neko-webshell', 'Unexpected repository profile');
  ensure(typeof profile.signingCertificateSha256 === 'string' && sha256.test(profile.signingCertificateSha256) &&
    profile.signingCertificateSha256 !== '0'.repeat(64), 'A production signing certificate fingerprint must be pinned');
  ensure(positiveInteger(profile.maxArchiveBytes) && profile.maxArchiveBytes <= 1024 ** 3, 'Invalid native archive bound');
}

function validateRun(run, repository, workflow, version, commit, requestedID, profile) {
  const tag = profile.tagPrefix + version;
  ensure(repository.private === true && repository.full_name === profile.sourceRepository && positiveInteger(repository.id), 'Expected the pinned private source repository');
  ensure(workflow.path === `.github/workflows/${profile.sourceWorkflow}` && positiveInteger(workflow.id) && workflow.state === 'active', 'Unexpected private workflow identity');
  ensure(run.id === requestedID && run.workflow_id === workflow.id && run.path === workflow.path &&
    run.repository?.id === repository.id && run.repository?.full_name === profile.sourceRepository &&
    run.head_repository?.id === repository.id && run.head_repository?.full_name === profile.sourceRepository &&
    run.status === 'completed' && run.conclusion === 'success' && ['push', 'workflow_dispatch'].includes(run.event) &&
    run.head_branch === tag && sha40.test(run.head_sha) && run.head_sha === commit && positiveInteger(run.run_attempt) &&
    Array.isArray(run.pull_requests) && run.pull_requests.length === 0,
  'Expected the successful trusted private tag/workflow/commit; PR, fork, branch, and incomplete runs are rejected');
}

async function tagCommit(github, owner, repo, tag) {
  let object = (await github.rest.git.getRef({owner, repo, ref: `tags/${tag}`})).data.object;
  const seen = new Set();
  for (let depth = 0; depth < 5; depth++) {
    ensure(object && sha40.test(object.sha) && !seen.has(object.sha), 'Invalid or cyclic release tag identity');
    seen.add(object.sha);
    if (object.type === 'commit') return object.sha;
    ensure(object.type === 'tag', 'Release tag does not resolve to a commit');
    const data = (await github.rest.git.getTag({owner, repo, tag_sha: object.sha})).data;
    ensure(data.sha === object.sha, 'Annotated tag identity mismatch');
    object = data.object;
  }
  throw new Error('Release tag indirection exceeds bound');
}

async function selectSource({github, version, commit, runID, profile = loadProfile()}) {
  validateProfile(profile);
  ensure(stableVersion.test(version || '') && sha40.test(commit || '') && /^[1-9]\d*$/.test(String(runID)), 'Explicit native version, source commit, and source run ID are required');
  runID = Number(runID);
  ensure(positiveInteger(runID), 'Invalid source run ID');
  const [owner, repo] = profile.sourceRepository.split('/');
  const repository = (await github.rest.repos.get({owner, repo})).data;
  const workflow = (await github.rest.actions.getWorkflow({owner, repo, workflow_id: profile.sourceWorkflow})).data;
  const run = (await github.rest.actions.getWorkflowRun({owner, repo, run_id: runID})).data;
  validateRun(run, repository, workflow, version, commit, runID, profile);
  ensure(await tagCommit(github, owner, repo, profile.tagPrefix + version) === commit, 'Source release tag moved or differs from workflow headSHA');
  const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, {owner, repo, run_id: runID, per_page: 100});
  const matches = artifacts.filter(artifact => artifact.name.startsWith(profile.artifactPrefix));
  ensure(matches.length === 1 && matches[0].name === profile.artifactPrefix + version && matches[0].expired === false,
    'Expected exactly one unexpired native artifact with the exact versioned name');
  const artifact = matches[0];
  ensure(positiveInteger(artifact.id) && positiveInteger(artifact.size_in_bytes) && artifact.size_in_bytes <= profile.maxArchiveBytes &&
    /^sha256:[0-9a-f]{64}$/.test(artifact.digest || ''), 'Native artifact has no valid bounded size/SHA256 digest');
  ensure(artifact.workflow_run?.id === runID && artifact.workflow_run?.head_sha === commit &&
    artifact.workflow_run?.repository_id === repository.id && artifact.workflow_run?.head_repository_id === repository.id &&
    artifact.workflow_run?.head_branch === profile.tagPrefix + version, 'Artifact workflow source identity differs');
  ensure(Number.isFinite(Date.parse(artifact.expires_at)) && Date.parse(artifact.expires_at) > Date.now(), 'Native artifact expired');
  return {
    schemaVersion: 1, version, sourceRepository: profile.sourceRepository, sourceCommit: commit,
    sourceRunId: run.id, sourceRunAttempt: run.run_attempt, sourceWorkflow: profile.sourceWorkflow,
    sourceEvent: run.event, sourceRef: 'refs/tags/' + profile.tagPrefix + version,
    artifactId: artifact.id, artifactName: artifact.name, artifactDigest: artifact.digest, artifactSize: artifact.size_in_bytes,
  };
}

async function downloadArchive({selection, token, output, profile = loadProfile(), fetchImpl = fetch}) {
  validateProfile(profile);
  return downloadArtifactArchive({selection, token, output, profile, fetchImpl});
}

async function downloadArtifactArchive({selection, token, output, profile, fetchImpl = fetch}) {
  ensure(typeof token === 'string' && token.length > 0, 'Private source read token is required');
  ensure(selection.sourceRepository === profile.sourceRepository && positiveInteger(selection.artifactId) &&
    positiveInteger(selection.artifactSize) && selection.artifactSize <= profile.maxArchiveBytes, 'Invalid selected artifact');
  const signal = AbortSignal.timeout(120000);
  const redirect = await fetchImpl(`https://api.github.com/repos/${profile.sourceRepository}/actions/artifacts/${selection.artifactId}/zip`, {
    headers: {authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'}, redirect: 'manual', signal,
  });
  ensure(redirect.status === 302, 'GitHub did not return an artifact download redirect');
  const url = new URL(redirect.headers.get('location'));
  ensure(url.protocol === 'https:' && !url.username && !url.password && !url.port &&
    ['.blob.core.windows.net', '.githubusercontent.com'].some(suffix => url.hostname.endsWith(suffix)), 'Unexpected GitHub artifact download origin');
  const response = await fetchImpl(url, {redirect: 'manual', signal});
  ensure(response.status === 200 && response.body, 'Artifact CDN download failed or redirected');
  const length = response.headers.get('content-length');
  ensure(length === null || (/^[1-9]\d*$/.test(length) && Number(length) === selection.artifactSize), 'Artifact download Content-Length differs');
  fs.mkdirSync(path.dirname(output), {recursive: true, mode: 0o700});
  const file = fs.openSync(output, 'wx', 0o600);
  const digest = crypto.createHash('sha256');
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      ensure(size <= selection.artifactSize && size <= profile.maxArchiveBytes, 'Artifact download exceeds bound');
      digest.update(chunk);
      fs.writeFileSync(file, chunk);
    }
    ensure(size === selection.artifactSize && 'sha256:' + digest.digest('hex') === selection.artifactDigest, 'Downloaded archive digest/size differs from GitHub metadata');
  } catch (error) {
    fs.closeSync(file);
    fs.unlinkSync(output);
    throw error;
  }
  fs.closeSync(file);
}

function sourceInputs() {
  return {version: process.env.NATIVE_VERSION, commit: process.env.SOURCE_COMMIT, runID: process.env.SOURCE_RUN_ID};
}
async function selectAndDownload({github, core}) {
  const profile = loadProfile();
  const selection = await selectSource({github, ...sourceInputs(), profile});
  await downloadArchive({selection, token: process.env.SOURCE_REPO_TOKEN, output: path.join(work, 'artifact.zip'), profile});
  fs.writeFileSync(path.join(work, 'selection.json'), JSON.stringify(selection) + '\n', {flag: 'wx', mode: 0o600});
  core.notice(`Trusted native source ${selection.sourceCommit}, run ${selection.sourceRunId}, version ${selection.version}`);
}
async function revalidateSource({github}) {
  const selection = JSON.parse(fs.readFileSync(path.join(work, 'selection.json'), 'utf8'));
  const current = await selectSource({github, version: selection.version, commit: selection.sourceCommit, runID: selection.sourceRunId});
  ensure(isDeepStrictEqual(current, selection), 'Source run/artifact changed after validation');
}

function verifiedFiles(profile = loadProfile(), directory = work) {
  validateProfile(profile);
  const selection = JSON.parse(fs.readFileSync(path.join(directory, 'selection.json'), 'utf8'));
  const marker = JSON.parse(fs.readFileSync(path.join(directory, 'verification.json'), 'utf8'));
  ensure(marker.schemaVersion === 1 && marker.signingCertificateSha256 === profile.signingCertificateSha256 &&
    isDeepStrictEqual(marker.selection, selection), 'Native verification evidence does not match selected source/profile');
  ensure(stableVersion.test(selection.version) && selection.sourceRepository === profile.sourceRepository &&
    selection.sourceWorkflow === profile.sourceWorkflow && selection.sourceRef === 'refs/tags/' + profile.tagPrefix + selection.version &&
    sha40.test(selection.sourceCommit) && ['push', 'workflow_dispatch'].includes(selection.sourceEvent), 'Invalid verified native source');
  const apkName = `neoko-terminal-v${selection.version}-android-arm64.apk`;
  const expected = [apkName, 'checksums.txt', 'provenance.json'].sort();
  ensure(JSON.stringify(Object.keys(marker.files).sort()) === JSON.stringify(expected) &&
    JSON.stringify(fs.readdirSync(path.join(directory, 'verified')).sort()) === JSON.stringify(expected), 'Verified output has unexpected files');
  const files = expected.map(name => {
    const filename = path.join(directory, 'verified', name);
    const status = fs.lstatSync(filename);
    const bound = name === apkName ? profile.maxApkBytes : 8192;
    ensure(status.isFile() && !status.isSymbolicLink() && status.nlink === 1 && status.size > 0 && status.size <= bound, 'Invalid verified output identity/size');
    const bytes = fs.readFileSync(filename);
    ensure(sha256.test(marker.files[name]) && hash(bytes) === marker.files[name], 'Verified native file changed before publication');
    return {name, bytes, sha256: marker.files[name]};
  });
  return {selection, files};
}

async function assetBytes(github, owner, repo, asset, limit) {
  ensure(positiveInteger(asset.size) && asset.size <= limit, 'Remote release asset exceeds expected size');
  const response = await github.request('GET /repos/{owner}/{repo}/releases/assets/{asset_id}', {
    owner, repo, asset_id: asset.id, headers: {accept: 'application/octet-stream'}, request: {timeout: 120000},
  });
  const bytes = Buffer.from(response.data);
  ensure(bytes.length === asset.size && bytes.length <= limit, 'Remote release asset size differs');
  return bytes;
}

async function publishRelease({github, context, core, dryRun = true, releaseCommit = context.sha, profile = loadProfile(), directory = work}) {
  const {selection, files} = verifiedFiles(profile, directory);
  return publishVerifiedRelease({github, context, core, dryRun, releaseCommit, profile, selection, files,
    body: `Android arm64-v8a native client ${selection.version}.\n\nSource: ${selection.sourceRepository}@${selection.sourceCommit}\nBuild run: ${selection.sourceRunId} (attempt ${selection.sourceRunAttempt}).\n\nIncludes the production-signed APK, checksums and provenance.`,
  });
}

async function publishVerifiedRelease({github, context, core, dryRun = true, releaseCommit = context.sha, profile, selection, files, body}) {
  const {owner, repo} = context.repo;
  ensure(`${owner}/${repo}` === profile.publicRepository && context.eventName === 'workflow_dispatch' &&
    context.ref === 'refs/heads/main' && sha40.test(context.sha), 'Native publication requires the trusted public main workflow_dispatch');
  ensure(typeof releaseCommit === 'string' && sha40.test(releaseCommit), 'Release commit must be a full lowercase SHA');
  if (releaseCommit !== context.sha) {
    const comparison = (await github.rest.repos.compareCommits({owner, repo, base: releaseCommit, head: context.sha})).data;
    ensure(comparison.status === 'ahead' && comparison.base_commit?.sha === releaseCommit &&
      comparison.merge_base_commit?.sha === releaseCommit && comparison.behind_by === 0 &&
      positiveInteger(comparison.ahead_by), 'Release commit must be an ancestor of the current public main commit');
  }
  if (dryRun !== false) {
    core.notice(`Dry run: verified ${profile.tagPrefix}${selection.version}; no Release or tag writes`);
    return;
  }
  const tag = profile.tagPrefix + selection.version;
  let exists = false;
  try {
    ensure(await tagCommit(github, owner, repo, tag) === releaseCommit, 'Existing native public tag points to another commit; tags are immutable');
    exists = true;
  } catch (error) { if (error.status !== 404) throw error; }
  const releases = await github.paginate(github.rest.repos.listReleases, {owner, repo, per_page: 100});
  const matches = releases.filter(release => release.tag_name === tag);
  ensure(matches.length <= 1, 'Multiple native Releases have the same tag');
  let release = matches[0];
  let assets = [];
  if (release) {
    ensure(exists, 'Existing native Release has no immutable public tag');
    assets = await github.paginate(github.rest.repos.listReleaseAssets, {owner, repo, release_id: release.id, per_page: 100});
    ensure(assets.every(asset => files.some(file => file.name === asset.name)) &&
      new Set(assets.map(asset => asset.name)).size === assets.length, 'Native Release has unexpected or duplicate assets');
    for (const asset of assets) {
      const file = files.find(file => file.name === asset.name);
      ensure(asset.size === file.bytes.length && hash(await assetBytes(github, owner, repo, asset, file.bytes.length)) === file.sha256,
        'Existing native Release bytes differ; assets are never overwritten');
    }
  }
  if (!exists) await github.rest.git.createRef({owner, repo, ref: `refs/tags/${tag}`, sha: releaseCommit});
  if (!release) release = (await github.rest.repos.createRelease({
    owner, repo, tag_name: tag, target_commitish: releaseCommit, name: `${profile.name} ${selection.version}`, draft: true,
    prerelease: false, make_latest: 'false', body,
  })).data;
  for (const file of files) {
    let asset = assets.find(asset => asset.name === file.name);
    if (!asset) asset = (await github.rest.repos.uploadReleaseAsset({
      owner, repo, release_id: release.id, name: file.name, data: file.bytes,
      headers: {'content-type': file.name.endsWith('.apk') ? 'application/vnd.android.package-archive' : 'application/octet-stream', 'content-length': file.bytes.length},
    })).data;
    ensure(asset.size === file.bytes.length && hash(await assetBytes(github, owner, repo, asset, file.bytes.length)) === file.sha256,
      'Uploaded native Release bytes differ on readback');
  }
  ensure(await tagCommit(github, owner, repo, tag) === releaseCommit, 'Native public tag changed before completion');
  if (release.draft) release = (await github.rest.repos.updateRelease({owner, repo, release_id: release.id, draft: false, make_latest: 'false'})).data;
  core.notice(`Published verified native Release ${tag}`);
  core.setOutput('release-url', release.html_url);
}

module.exports = {loadProfile, validateProfile, validateRun, tagCommit, selectSource, downloadArchive,
  selectAndDownload, revalidateSource, verifiedFiles, publishRelease, downloadArtifactArchive, publishVerifiedRelease};

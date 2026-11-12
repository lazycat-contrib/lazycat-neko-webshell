const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const native = require('./neoko-terminal.cjs');
const root = path.resolve(__dirname, '..');
const profile = native.loadProfile();
const commit = 'a'.repeat(40);
const publicCommit = 'b'.repeat(40);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const repository = {id: 42, full_name: profile.sourceRepository, private: true};
const workflow = {id: 73, path: '.github/workflows/neoko-terminal-android.yml', state: 'active'};
const trusted = {
  id: 123, workflow_id: workflow.id, path: workflow.path, repository, head_repository: repository,
  status: 'completed', conclusion: 'success', event: 'push', head_branch: 'neoko-terminal-android-v0.1.0',
  head_sha: commit, run_attempt: 1, pull_requests: [],
};
const artifact = {
  id: 456, name: 'neoko-terminal-android-v0.1.0', expired: false, size_in_bytes: 3,
  digest: 'sha256:' + sha('zip'), expires_at: '2099-01-01T00:00:00Z',
  workflow_run: {id: 123, head_sha: commit, repository_id: 42, head_repository_id: 42, head_branch: trusted.head_branch},
};
function sourceGithub({run = trusted, artifacts = [artifact], tag = commit, repo = repository, wf = workflow} = {}) {
  return {rest: {repos: {get: async () => ({data: repo})}, actions: {
    getWorkflow: async () => ({data: wf}), getWorkflowRun: async () => ({data: run}), listWorkflowRunArtifacts() {},
  }, git: {getRef: async () => ({data: {object: {type: 'commit', sha: tag}}})}}, paginate: async () => artifacts};
}
function select(github) { return native.selectSource({github, version: '0.1.0', commit, runID: '123', profile}); }
function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(root, '.native-test-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  return directory;
}

test('production certificate is pinned and missing/placeholder fingerprints fail closed', () => {
  assert.equal(profile.signingCertificateSha256, '6e2df6d3940b6898cb749365015483c52d40c2991995ab47333c03328b142e8e');
  for (const fingerprint of [null, undefined, '', '0'.repeat(64), 'A'.repeat(64)]) {
    assert.throws(() => native.validateProfile({...profile, signingCertificateSha256: fingerprint}), /must be pinned/);
  }
});

test('successful private tag run selects exactly its matching immutable native artifact', async () => {
  const selection = await select(sourceGithub());
  assert.equal(selection.sourceCommit, commit);
  assert.equal(selection.sourceWorkflow, 'neoko-terminal-android.yml');
  assert.equal(selection.artifactDigest, artifact.digest);
  assert.equal(selection.sourceRef, 'refs/tags/neoko-terminal-android-v0.1.0');
  await select(sourceGithub({run: {...trusted, event: 'workflow_dispatch'}}));
});

test('PR, fork, branch, workflow, status, attempt, run ID, and headSHA substitutions fail', async () => {
  const overrides = [{event: 'pull_request'}, {event: 'pull_request_target'}, {event: 'workflow_run'},
    {head_repository: {...repository, id: 99}}, {head_repository: {...repository, full_name: 'attacker/fork'}},
    {repository: {...repository, id: 99}}, {head_branch: 'main'}, {head_branch: 'v0.1.0'},
    {workflow_id: 99}, {path: '.github/workflows/lazycat.yml'}, {status: 'in_progress'},
    {conclusion: 'failure'}, {head_sha: 'f'.repeat(40)}, {run_attempt: 0}, {id: 124}, {pull_requests: [{number: 1}]}];
  for (const override of overrides) await assert.rejects(select(sourceGithub({run: {...trusted, ...override}})), /trusted private/);
  await assert.rejects(select(sourceGithub({repo: {...repository, private: false}})), /private source/);
  await assert.rejects(select(sourceGithub({wf: {...workflow, state: 'disabled_manually'}})), /workflow identity/);
  await assert.rejects(select(sourceGithub({tag: 'f'.repeat(40)})), /headSHA/);
});

test('annotated tags resolve to the expected commit and cycles are rejected', async () => {
  const github = sourceGithub();
  github.rest.git.getRef = async () => ({data: {object: {type: 'tag', sha: 'c'.repeat(40)}}});
  github.rest.git.getTag = async () => ({data: {sha: 'c'.repeat(40), object: {type: 'commit', sha: commit}}});
  await select(github);
  github.rest.git.getTag = async () => ({data: {sha: 'c'.repeat(40), object: {type: 'tag', sha: 'c'.repeat(40)}}});
  await assert.rejects(select(github), /cyclic/);
});

test('missing, duplicate, expired, mismatched, unsigned-digest and oversized artifacts fail', async () => {
  for (const artifacts of [[], [artifact, artifact], [{...artifact, expired: true}],
    [{...artifact, name: 'neoko-terminal-android-v0.1.1'}], [{...artifact, digest: null}],
    [{...artifact, size_in_bytes: profile.maxArchiveBytes + 1}], [{...artifact, expires_at: '2020-01-01'}],
    [{...artifact, workflow_run: {...artifact.workflow_run, head_sha: 'f'.repeat(40)}}]]) {
    await assert.rejects(select(sourceGithub({artifacts})));
  }
});

test('explicit version, commit and run ID are required and never interpolate unsafe refs', async () => {
  for (const options of [{version: '0.1.0;echo bad'}, {commit: 'main'}, {runID: '1e2'}, {runID: '9007199254740992'}, {version: 'v0.1.0'}]) {
    await assert.rejects(native.selectSource({github: sourceGithub(), version: '0.1.0', commit, runID: '123', ...options, profile}));
  }
});

test('bounded archive download strips private token at the CDN and verifies metadata digest', async t => {
  const directory = temporaryDirectory(t);
  const calls = [];
  const selection = await select(sourceGithub());
  await native.downloadArchive({selection, token: 'private-token', output: path.join(directory, 'artifact.zip'), profile,
    fetchImpl: async (url, options) => {
      calls.push({url: String(url), options});
      return calls.length === 1 ? new Response(null, {status: 302, headers: {location: 'https://trusted.blob.core.windows.net/a.zip'}}) : new Response('zip');
    }});
  assert.equal(calls[0].options.headers.authorization, 'Bearer private-token');
  assert.equal(calls[1].options.headers, undefined);
  assert.equal(calls[1].options.redirect, 'manual');
  assert.equal(fs.readFileSync(path.join(directory, 'artifact.zip'), 'utf8'), 'zip');
});

test('untrusted redirects, oversize bodies, and digest mismatches never leave a usable ZIP', async t => {
  const directory = temporaryDirectory(t);
  const selection = await select(sourceGithub());
  for (const location of ['https://attacker.example/a.zip', 'http://trusted.blob.core.windows.net/a.zip', 'https://user:secret@trusted.blob.core.windows.net/a.zip']) {
    await assert.rejects(native.downloadArchive({selection, token: 'token', output: path.join(directory, 'artifact.zip'), profile,
      fetchImpl: async () => new Response(null, {status: 302, headers: {location}})}), /origin/);
  }
  for (const body of ['oversized', 'bad']) {
    let count = 0;
    await assert.rejects(native.downloadArchive({selection, token: 'token', output: path.join(directory, 'artifact.zip'), profile,
      fetchImpl: async () => ++count === 1 ? new Response(null, {status: 302, headers: {location: 'https://trusted.blob.core.windows.net/a.zip'}}) : new Response(body)}));
    assert.equal(fs.existsSync(path.join(directory, 'artifact.zip')), false);
  }
});

function verifiedFixture(t) {
  const directory = temporaryDirectory(t);
  const selection = {schemaVersion: 1, version: '0.1.0', sourceRepository: profile.sourceRepository, sourceCommit: commit,
    sourceRunId: 123, sourceRunAttempt: 1, sourceWorkflow: 'neoko-terminal-android.yml', sourceEvent: 'push', sourceRef: 'refs/tags/neoko-terminal-android-v0.1.0'};
  const files = {'neoko-terminal-v0.1.0-android-arm64.apk': Buffer.from('verified APK'), 'checksums.txt': Buffer.from('checksum'), 'provenance.json': Buffer.from('{}')};
  fs.mkdirSync(path.join(directory, 'verified'));
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(directory, 'verified', name), bytes);
  const hashes = Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, sha(bytes)]));
  const reordered = Object.fromEntries(Object.entries(selection).sort());
  fs.writeFileSync(path.join(directory, 'selection.json'), JSON.stringify(selection));
  fs.writeFileSync(path.join(directory, 'verification.json'), JSON.stringify({schemaVersion: 1, selection: reordered, files: hashes, signingCertificateSha256: profile.signingCertificateSha256}));
  return {directory, selection, files};
}
function publicGithub({assets = [], wrongReadback = false, tag = null, draft = true, existing = false, comparison} = {}) {
  const writes = [];
  const comparisons = [];
  let tagSHA = tag;
  const release = {id: 7, tag_name: 'neoko-terminal-android-v0.1.0', draft, html_url: 'https://github.com/public/release'};
  const github = {
    rest: {git: {
      getRef: async () => { if (!tagSHA) throw Object.assign(new Error('missing'), {status: 404}); return {data: {object: {type: 'commit', sha: tagSHA}}}; },
      createRef: async request => { writes.push(['tag', request]); tagSHA = request.sha; },
    }, repos: {
      compareCommits: async request => { comparisons.push(request); if (comparison instanceof Error) throw comparison; return {data: comparison}; },
      listReleases() {}, listReleaseAssets() {},
      createRelease: async request => { writes.push(['create', request]); return {data: release}; },
      uploadReleaseAsset: async request => { writes.push(['upload', request]); const asset = {id: assets.length + 1, name: request.name, size: request.data.length, bytes: request.data}; assets.push(asset); return {data: asset}; },
      updateRelease: async request => { writes.push(['publish', request]); return {data: {...release, draft: false}}; },
    }},
    paginate: async method => method === github.rest.repos.listReleases ? (existing ? [release] : []) : assets,
    request: async (route, request) => ({data: wrongReadback ? Buffer.from('wrong') : assets.find(asset => asset.id === request.asset_id).bytes}),
  };
  return {github, writes, assets, comparisons};
}
const context = {repo: {owner: 'lazycat-contrib', repo: 'lazycat-neko-webshell'}, sha: publicCommit, ref: 'refs/heads/main', eventName: 'workflow_dispatch'};
const core = {notice() {}, setOutput() {}};

test('publication defaults to dry-run and creates no tags or assets', async t => {
  const fixture = verifiedFixture(t);
  const {github, writes} = publicGithub();
  await native.publishRelease({github, core, context, directory: fixture.directory, profile});
  assert.deepEqual(writes, []);
});

test('publication refuses PR/branch/fork context before any writes', async t => {
  const fixture = verifiedFixture(t);
  for (const change of [{eventName: 'pull_request'}, {ref: 'refs/heads/attacker'}, {repo: {owner: 'attacker', repo: 'fork'}}]) {
    const {github, writes} = publicGithub();
    await assert.rejects(native.publishRelease({github, core, context: {...context, ...change}, directory: fixture.directory, profile, dryRun: false}), /trusted public/);
    assert.deepEqual(writes, []);
  }
});

test('changed local payload or extra file fails publication before writes', async t => {
  const fixture = verifiedFixture(t);
  fs.writeFileSync(path.join(fixture.directory, 'verified', 'checksums.txt'), 'changed');
  const {github, writes} = publicGithub();
  await assert.rejects(native.publishRelease({github, core, context, directory: fixture.directory, profile, dryRun: false}), /changed before/);
  assert.deepEqual(writes, []);
});

test('actual native release reads back every attachment before leaving draft and preserves Latest', async t => {
  const fixture = verifiedFixture(t);
  const {github, writes} = publicGithub();
  await native.publishRelease({github, core, context, directory: fixture.directory, profile, dryRun: false});
  assert.equal(writes.filter(([type]) => type === 'upload').length, 3);
  assert.equal(writes.at(-1)[0], 'publish');
  assert.equal(writes.find(([type]) => type === 'create')[1].make_latest, 'false');
  assert.equal(writes.at(-1)[1].make_latest, 'false');
  assert.equal(writes[0][1].ref, 'refs/tags/neoko-terminal-android-v0.1.0');
});

test('different existing native public tag is never moved', async t => {
  const fixture = verifiedFixture(t);
  const {github, writes} = publicGithub({tag: 'f'.repeat(40)});
  await assert.rejects(native.publishRelease({github, core, context, directory: fixture.directory, profile, dryRun: false}), /immutable/);
  assert.deepEqual(writes, []);
});

test('existing differing asset is never overwritten or partially repaired', async t => {
  const fixture = verifiedFixture(t);
  const {github, writes} = publicGithub({tag: publicCommit, existing: true, assets: [{id: 1, name: 'checksums.txt', size: 3, bytes: Buffer.from('bad')}]});
  await assert.rejects(native.publishRelease({github, core, context, directory: fixture.directory, profile, dryRun: false}), /never overwritten/);
  assert.deepEqual(writes, []);
});

test('identical draft assets resume without duplicate uploads', async t => {
  const fixture = verifiedFixture(t);
  const bytes = fixture.files['checksums.txt'];
  const {github, writes} = publicGithub({tag: publicCommit, existing: true, assets: [{id: 1, name: 'checksums.txt', size: bytes.length, bytes}]});
  await native.publishRelease({github, core, context, directory: fixture.directory, profile, dryRun: false});
  assert.equal(writes.filter(([type]) => type === 'upload').length, 2);
  assert.equal(writes.some(([type]) => type === 'tag'), false);
  assert.equal(writes.at(-1)[0], 'publish');
});

test('failed remote attachment readback cannot publish the draft', async t => {
  const fixture = verifiedFixture(t);
  const {github, writes} = publicGithub({wrongReadback: true});
  await assert.rejects(native.publishRelease({github, core, context, directory: fixture.directory, profile, dryRun: false}), /size differs|readback/);
  assert.equal(writes.some(([type]) => type === 'publish'), false);
});

test('native workflow stays manual, dry-run-default and independent of every storefront path', () => {
  const workflowText = fs.readFileSync(path.join(root, '.github/workflows/publish-neoko-terminal-android.yml'), 'utf8');
  assert.match(workflowText, /workflow_dispatch:/);
  assert.match(workflowText, /dry-run:[\s\S]*default: true/);
  assert.doesNotMatch(workflowText, /schedule:|publish-lpk|prepare-lpk|lazycat-github-action|APPSTORE|LZC_API_TOKEN/);
  assert.match(workflowText, /revalidateSource/);
  assert.match(workflowText, /      release-commit:/);
  assert.match(workflowText, /releaseCommit: process.env.RELEASE_COMMIT \|\| context.sha/);
  assert.match(workflowText, /DRY_RUN !== 'false'/);
});

test('renamed Android contract pins the component, identity and signing certificate', () => {
  assert.equal(profile.component, 'neoko-terminal');
  assert.equal(profile.name, 'neoko-terminal');
  assert.equal(profile.packageName, 'community.lazycat.neko.remoted');
  assert.equal(profile.tagPrefix, 'neoko-terminal-android-v');
  assert.equal(profile.artifactPrefix, 'neoko-terminal-android-v');
  assert.equal(profile.sourceWorkflow, 'neoko-terminal-android.yml');
  for (const change of [
    {component: 'remoted-client'}, {tagPrefix: 'remoted-client-v'},
    {tagPrefix: 'neoko-terminal-desktop-v'}, {artifactPrefix: 'remoted-client-native-v'},
    {sourceWorkflow: 'remoted-client.yml'}, {sourceWorkflow: 'neoko-terminal-desktop.yml'},
  ]) assert.throws(() => native.validateProfile({...profile, ...change}), /component profile/);
});

test('old and desktop workflows, tags and artifacts cannot enter Android publication', async () => {
  for (const filename of ['remoted-client.yml', 'neoko-terminal-desktop.yml']) {
    const wf = {...workflow, path: `.github/workflows/${filename}`};
    await assert.rejects(select(sourceGithub({wf, run: {...trusted, path: wf.path}})), /workflow identity/);
  }
  for (const head_branch of ['remoted-client-v0.1.0', 'neoko-terminal-desktop-v0.1.0']) {
    await assert.rejects(select(sourceGithub({run: {...trusted, head_branch}})), /trusted private/);
  }
  for (const name of ['remoted-client-native-v0.1.0', 'neoko-terminal-0.1.0-x86_64-unknown-linux-gnu']) {
    await assert.rejects(select(sourceGithub({artifacts: [{...artifact, name}]})), /exactly one/);
  }
});

test('old APK filename cannot publish even with a matching local verification hash', async t => {
  const fixture = verifiedFixture(t);
  const oldName = 'neko-remoted-client-v0.1.0-android-arm64.apk';
  const newName = 'neoko-terminal-v0.1.0-android-arm64.apk';
  fs.renameSync(path.join(fixture.directory, 'verified', newName), path.join(fixture.directory, 'verified', oldName));
  const markerPath = path.join(fixture.directory, 'verification.json');
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  marker.files[oldName] = marker.files[newName];
  delete marker.files[newName];
  fs.writeFileSync(markerPath, JSON.stringify(marker));
  const {github, writes} = publicGithub();
  await assert.rejects(native.publishRelease({github, core, context, directory: fixture.directory, profile, dryRun: false}), /unexpected files/);
  assert.deepEqual(writes, []);
});


test('android explicit ancestor resumes a fixed public draft without moving its tag', async t => {
  const fixture = verifiedFixture(t);
  const releaseCommit = 'c'.repeat(40);
  const comparison = {status: 'ahead', base_commit: {sha: releaseCommit}, merge_base_commit: {sha: releaseCommit}, ahead_by: 2, behind_by: 0};
  const {github, writes, comparisons} = publicGithub({tag: releaseCommit, existing: true, comparison});
  await native.publishRelease({github, core, context, releaseCommit, directory: fixture.directory, dryRun: false});
  assert.deepEqual(comparisons, [{owner: context.repo.owner, repo: context.repo.repo, base: releaseCommit, head: context.sha}]);
  assert.equal(writes.some(([type]) => type === 'tag' || type === 'create'), false);
  assert.equal(writes.at(-1)[0], 'publish');
  // The private source SHA stays independent of the public release commit.
  assert.equal(fixture.selection.sourceCommit, commit);
});

test('android release commit rejects invalid and nonancestor values even in dry runs', async t => {
  const fixture = verifiedFixture(t);
  const ancestor = 'c'.repeat(40);
  const valid = {status: 'ahead', base_commit: {sha: ancestor}, merge_base_commit: {sha: ancestor}, ahead_by: 1, behind_by: 0};
  for (const releaseCommit of ['', null, 'main', 'A'.repeat(40), 'a'.repeat(39), 123]) {
    const {github, writes, comparisons} = publicGithub();
    await assert.rejects(native.publishRelease({github, core, context, releaseCommit, directory: fixture.directory}), /full lowercase SHA/);
    assert.deepEqual(writes, []);
    assert.deepEqual(comparisons, []);
  }
  for (const comparison of [{...valid, status: 'behind'}, {...valid, status: 'diverged'},
    {...valid, merge_base_commit: {sha: 'f'.repeat(40)}}, {...valid, base_commit: {sha: 'f'.repeat(40)}},
    {...valid, behind_by: 1}, {...valid, ahead_by: 0}, Object.assign(new Error('compare denied'), {status: 403})]) {
    const {github, writes} = publicGithub({comparison});
    await assert.rejects(native.publishRelease({github, core, context, releaseCommit: ancestor, directory: fixture.directory}));
    assert.deepEqual(writes, []);
  }
  const {github, writes, comparisons} = publicGithub({comparison: valid});
  await native.publishRelease({github, core, context, releaseCommit: ancestor, directory: fixture.directory});
  assert.equal(comparisons.length, 1);
  assert.deepEqual(writes, []);
});

test('android identical release commit needs no comparison and new tags default to main', async t => {
  const fixture = verifiedFixture(t);
  const {github, writes, comparisons} = publicGithub();
  await native.publishRelease({github, core, context, releaseCommit: context.sha, directory: fixture.directory, dryRun: false});
  assert.deepEqual(comparisons, []);
  assert.equal(writes.find(([type]) => type === 'tag')[1].sha, context.sha);
  assert.equal(writes.find(([type]) => type === 'create')[1].target_commitish, context.sha);
});

 test('native toolchain profile pins are exact and fail closed', () => {
  for (const key of Object.keys(profile.nativeBuildInputs)) {
    assert.throws(() => native.validateProfile({...profile, nativeBuildInputs: {...profile.nativeBuildInputs, [key]: 'wrong'}}), /pins/);
  }
  for (const value of [undefined, {}, {...profile.nativeBuildInputs, extra: 'x'}]) {
    assert.throws(() => native.validateProfile({...profile, nativeBuildInputs: value}), /pins/);
  }
});

test('Android app protocol is pinned to version 2', () => {
  assert.equal(profile.protocolVersion, 2);
  for (const protocolVersion of [1, 3, true, '2', undefined]) {
    assert.throws(() => native.validateProfile({...profile, protocolVersion}), /protocol/);
  }
});

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const desktop = require('./neoko-terminal-desktop.cjs');
const root = path.resolve(__dirname, '..');
const profile = desktop.loadProfile();
const commit = 'a'.repeat(40);
const publicCommit = 'b'.repeat(40);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const repository = {id: 42, full_name: profile.sourceRepository, private: true};
const workflow = {id: 73, path: '.github/workflows/neoko-terminal-desktop.yml', state: 'active'};
const trusted = {id: 123, workflow_id: workflow.id, path: workflow.path, repository, head_repository: repository,
  status: 'completed', conclusion: 'success', event: 'push', head_branch: 'neoko-terminal-desktop-v0.4.0',
  head_sha: commit, run_attempt: 1, pull_requests: []};
const artifacts = profile.targets.map((target, index) => ({id: index + 1, name: `neoko-terminal-desktop-0.4.0-${target}`,
  expired: false, size_in_bytes: 3, digest: 'sha256:' + sha('zip'), expires_at: '2099-01-01T00:00:00Z',
  workflow_run: {id: 123, head_sha: commit, repository_id: 42, head_repository_id: 42, head_branch: trusted.head_branch}}));
function sourceGithub({run = trusted, files = artifacts, tag = commit, repo = repository, wf = workflow} = {}) {
  return {rest: {repos: {get: async () => ({data: repo})}, actions: {
    getWorkflow: async () => ({data: wf}), getWorkflowRun: async () => ({data: run}), listWorkflowRunArtifacts() {},
  }, git: {getRef: async () => ({data: {object: {type: 'commit', sha: tag}}})}}, paginate: async () => files};
}
function select(github) { return desktop.selectSource({github, version: '0.4.0', commit, runID: '123', profile}); }
function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-publish-test-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  return directory;
}
async function verifiedFixture(t) {
  const directory = temporaryDirectory(t);
  const selection = await select(sourceGithub());
  const files = Object.fromEntries(desktop.expectedFiles(selection.version, profile).map(name => [name, Buffer.from('verified ' + name)]));
  fs.mkdirSync(path.join(directory, 'verified'));
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(directory, 'verified', name), bytes);
  const hashes = Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, sha(bytes)]));
  fs.writeFileSync(path.join(directory, 'selection.json'), JSON.stringify(selection));
  fs.writeFileSync(path.join(directory, 'verification.json'), JSON.stringify({schemaVersion: 1, selection, files: hashes, profile}));
  return {directory, selection, files};
}

test('successful immutable private desktop tag selects exactly four target artifacts', async () => {
  const selection = await select(sourceGithub({files: [...artifacts].reverse()}));
  assert.equal(selection.sourceWorkflow, 'neoko-terminal-desktop.yml');
  assert.equal(selection.sourceRef, 'refs/tags/neoko-terminal-desktop-v0.4.0');
  assert.equal(selection.sourceCommit, commit);
  assert.deepEqual(selection.artifacts.map(a => a.target), profile.targets);
  await select(sourceGithub({run: {...trusted, event: 'workflow_dispatch'}}));
});

test('desktop source rejects PRs forks branches workflow substitutions and unfinished or rerun identities', async () => {
  for (const change of [{event: 'pull_request'}, {event: 'pull_request_target'}, {event: 'workflow_run'},
    {head_repository: {...repository, id: 99}}, {repository: {...repository, full_name: 'attacker/fork'}},
    {workflow_id: 99}, {path: '.github/workflows/neoko-terminal-android.yml'}, {head_branch: 'main'},
    {head_branch: 'neoko-terminal-android-v0.4.0'}, {head_sha: 'f'.repeat(40)}, {run_attempt: 0}, {id: 124},
    {status: 'in_progress'}, {conclusion: 'failure'}, {pull_requests: [{number: 1}]}]) {
    await assert.rejects(select(sourceGithub({run: {...trusted, ...change}})));
  }
  await assert.rejects(select(sourceGithub({repo: {...repository, private: false}})));
  await assert.rejects(select(sourceGithub({wf: {...workflow, path: '.github/workflows/other.yml'}})));
  await assert.rejects(select(sourceGithub({wf: {...workflow, state: 'disabled_manually'}})));
  await assert.rejects(select(sourceGithub({tag: 'f'.repeat(40)})), /tag moved/);
});

test('desktop versions commits IDs and profile namespaces fail closed', async () => {
  for (const change of [{version: '0.4.0;bad'}, {version: '03.0.0'}, {version: '0.4.0-rc1'}, {commit: 'main'}, {runID: '1e2'}, {runID: '9007199254740992'}]) {
    await assert.rejects(desktop.selectSource({github: sourceGithub(), version: '0.4.0', commit, runID: '123', ...change}));
  }
  for (const change of [{sourceWorkflow: 'neoko-terminal-android.yml'}, {tagPrefix: 'remoted-client-desktop-v'},
    {crateVersion: '99.99.99'}, {crateVersion: undefined}, {targets: profile.targets.slice(1)}, {artifactPrefix: 'other-'}, {sourceRepository: 'attacker/fork'}]) {
    assert.throws(() => desktop.validateProfile({...profile, ...change}));
  }
});

test('missing duplicate foreign expired oversized or digestless desktop artifacts fail', async () => {
  for (const files of [artifacts.slice(1), [...artifacts, artifacts[0]], artifacts.map(() => artifacts[0]),
    ...[{id: artifacts[1].id}, {name: 'other-target'}, {expired: true}, {digest: null}, {expires_at: '2020-01-01'},
      {size_in_bytes: profile.maxArchiveBytes + 1}, {workflow_run: {...artifacts[0].workflow_run, head_sha: 'f'.repeat(40)}},
      {workflow_run: {...artifacts[0].workflow_run, repository_id: 99}},
      {workflow_run: {...artifacts[0].workflow_run, head_repository_id: 99}},
      {workflow_run: {...artifacts[0].workflow_run, id: 124}},
      {workflow_run: {...artifacts[0].workflow_run, head_branch: 'other'}}]
      .map(change => [{...artifacts[0], ...change}, ...artifacts.slice(1)])]) {
    await assert.rejects(select(sourceGithub({files})));
  }
});

test('desktop revalidation detects source attempt and any artifact digest mutation', async t => {
  const fixture = await verifiedFixture(t);
  await desktop.revalidateSource({github: sourceGithub(), directory: fixture.directory});
  await assert.rejects(desktop.revalidateSource({github: sourceGithub({run: {...trusted, run_attempt: 2}}), directory: fixture.directory}), /changed after/);
  const files = [{...artifacts[0], digest: 'sha256:' + 'f'.repeat(64)}, ...artifacts.slice(1)];
  await assert.rejects(desktop.revalidateSource({github: sourceGithub({files}), directory: fixture.directory}), /changed after/);
});
function publicGithub({assets = [], wrongReadback = false, tag = null, draft = true, existing = false, comparison} = {}) {
  const writes = [];
  const comparisons = [];
  let tagSHA = tag;
  const release = {id: 7, tag_name: 'neoko-terminal-desktop-v0.4.0', draft, html_url: 'https://github.com/public/release'};
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


test('desktop default dry run verifies twelve files and makes no remote writes', async t => {
  const fixture = await verifiedFixture(t);
  assert.equal(desktop.verifiedFiles(profile, fixture.directory).files.length, 12);
  const {github, writes} = publicGithub();
  await desktop.publishRelease({github, core, context, directory: fixture.directory});
  assert.deepEqual(writes, []);
});

test('desktop only uploads its twelve exact assets and publishes after all readbacks preserving Latest', async t => {
  const fixture = await verifiedFixture(t);
  const {github, writes} = publicGithub();
  await desktop.publishRelease({github, core, context, directory: fixture.directory, dryRun: false});
  assert.deepEqual(writes.filter(([type]) => type === 'upload').map(([,request]) => request.name).sort(), Object.keys(fixture.files).sort());
  assert.equal(writes[0][1].ref, 'refs/tags/neoko-terminal-desktop-v0.4.0');
  assert.equal(writes.at(-1)[0], 'publish');
  assert.equal(writes.find(([type]) => type === 'create')[1].draft, true);
  assert.equal(writes.find(([type]) => type === 'create')[1].make_latest, 'false');
  assert.equal(writes.at(-1)[1].make_latest, 'false');
});

test('desktop public fork PR branch and changed tags fail before writes', async t => {
  const fixture = await verifiedFixture(t);
  for (const change of [{eventName: 'pull_request'}, {ref: 'refs/heads/other'}, {repo: {owner: 'attacker', repo: 'fork'}}]) {
    const {github, writes} = publicGithub();
    await assert.rejects(desktop.publishRelease({github, core, context: {...context, ...change}, directory: fixture.directory, dryRun: false}));
    assert.deepEqual(writes, []);
  }
  const {github, writes} = publicGithub({tag: 'f'.repeat(40)});
  await assert.rejects(desktop.publishRelease({github, core, context, directory: fixture.directory, dryRun: false}), /immutable/);
  assert.deepEqual(writes, []);
});

test('desktop local extra files symlinks changed bytes and mismatching marker/profile fail before writes', async t => {
  for (const mutate of [
    fixture => fs.writeFileSync(path.join(fixture.directory, 'verified', 'source.rs'), 'private'),
    fixture => fs.writeFileSync(path.join(fixture.directory, 'verified', Object.keys(fixture.files)[0]), 'changed'),
    fixture => { const file = path.join(fixture.directory, 'verified', Object.keys(fixture.files)[0]); fs.unlinkSync(file); fs.symlinkSync('/etc/passwd', file); },
    fixture => { const file = path.join(fixture.directory, 'verification.json'); const marker = JSON.parse(fs.readFileSync(file)); marker.profile.nshRevision = 'f'.repeat(40); fs.writeFileSync(file, JSON.stringify(marker)); },
  ]) {
    const fixture = await verifiedFixture(t); mutate(fixture);
    const {github, writes} = publicGithub();
    await assert.rejects(desktop.publishRelease({github, core, context, directory: fixture.directory, dryRun: false}));
    assert.deepEqual(writes, []);
  }
});

test('desktop failed readback leaves draft and existing conflicting assets are never overwritten', async t => {
  const fixture = await verifiedFixture(t);
  for (const options of [{wrongReadback: true}, {tag: publicCommit, existing: true, assets: [{id: 1, name: 'unexpected.key', size: 3, bytes: Buffer.from('bad')}]},
    {tag: publicCommit, existing: true, assets: [{id: 1, name: Object.keys(fixture.files)[0], size: 3, bytes: Buffer.from('bad')}]}]) {
    const {github, writes} = publicGithub(options);
    await assert.rejects(desktop.publishRelease({github, core, context, directory: fixture.directory, dryRun: false}));
    assert.equal(writes.some(([type]) => type === 'publish'), false);
  }
});

test('desktop identical partial draft resumes without moving tag or duplicating assets', async t => {
  const fixture = await verifiedFixture(t);
  const [name, bytes] = Object.entries(fixture.files)[0];
  const {github, writes} = publicGithub({tag: publicCommit, existing: true, assets: [{id: 1, name, size: bytes.length, bytes}]});
  await desktop.publishRelease({github, core, context, directory: fixture.directory, dryRun: false});
  assert.equal(writes.filter(([type]) => type === 'upload').length, 11);
  assert.equal(writes.some(([type]) => type === 'tag'), false);
  assert.equal(writes.at(-1)[0], 'publish');
});

test('public desktop workflow only pulls private artifacts, verifies and revalidates before publication', () => {
  const workflowText = fs.readFileSync(path.join(root, '.github/workflows/neoko-terminal-desktop.yml'), 'utf8');
  assert.match(workflowText, /workflow_dispatch:/);
  for (const input of ['version', 'source-run-id', 'source-commit', 'release-commit', 'dry-run']) assert.match(workflowText, new RegExp(`      ${input}:`));
  assert.match(workflowText, /default: '0\.4\.0'/);
  assert.match(workflowText, /python-version: '3\.14'/);
  assert.match(workflowText, /releaseCommit: process.env.RELEASE_COMMIT \|\| context.sha/);
  assert.match(workflowText, /dry-run:[\s\S]*default: true/);
  assert.doesNotMatch(workflowText, /cargo |rust-toolchain|build-desktop\.py|upload-artifact|\n  push:|matrix:|resolveVersion/);
  assert.match(workflowText, /github-token: \$\{\{ secrets\.SOURCE_REPO_TOKEN \}\}/);
  assert.ok(workflowText.indexOf('.selectAndDownload(') < workflowText.indexOf('prepare-neoko-terminal-desktop.py'));
  assert.ok(workflowText.indexOf('prepare-neoko-terminal-desktop.py') < workflowText.indexOf('.revalidateSource('));
  assert.ok(workflowText.indexOf('.revalidateSource(') < workflowText.indexOf('.publishRelease('));
  const check = fs.readFileSync(path.join(root, '.github/workflows/check-neoko-terminal.yml'), 'utf8');
  assert.match(check, /scripts\/\*neoko\*/);
  assert.match(check, /python-version: '3\.14'/);
  assert.match(check, /test_neoko_terminal\*\.py/);
  assert.match(check, /scripts\/neoko-terminal-desktop\.test\.cjs/);
});


test('desktop explicit ancestor resumes a fixed public draft without moving its tag', async t => {
  const fixture = await verifiedFixture(t);
  const releaseCommit = 'c'.repeat(40);
  const comparison = {status: 'ahead', base_commit: {sha: releaseCommit}, merge_base_commit: {sha: releaseCommit}, ahead_by: 2, behind_by: 0};
  const {github, writes, comparisons} = publicGithub({tag: releaseCommit, existing: true, comparison});
  await desktop.publishRelease({github, core, context, releaseCommit, directory: fixture.directory, dryRun: false});
  assert.deepEqual(comparisons, [{owner: context.repo.owner, repo: context.repo.repo, base: releaseCommit, head: context.sha}]);
  assert.equal(writes.some(([type]) => type === 'tag' || type === 'create'), false);
  assert.equal(writes.at(-1)[0], 'publish');
  // The private source SHA stays independent of the public release commit.
  assert.equal(fixture.selection.sourceCommit, commit);
});

test('desktop release commit rejects invalid and nonancestor values even in dry runs', async t => {
  const fixture = await verifiedFixture(t);
  const ancestor = 'c'.repeat(40);
  const valid = {status: 'ahead', base_commit: {sha: ancestor}, merge_base_commit: {sha: ancestor}, ahead_by: 1, behind_by: 0};
  for (const releaseCommit of ['', null, 'main', 'A'.repeat(40), 'a'.repeat(39), 123]) {
    const {github, writes, comparisons} = publicGithub();
    await assert.rejects(desktop.publishRelease({github, core, context, releaseCommit, directory: fixture.directory}), /full lowercase SHA/);
    assert.deepEqual(writes, []);
    assert.deepEqual(comparisons, []);
  }
  for (const comparison of [{...valid, status: 'behind'}, {...valid, status: 'diverged'},
    {...valid, merge_base_commit: {sha: 'f'.repeat(40)}}, {...valid, base_commit: {sha: 'f'.repeat(40)}},
    {...valid, behind_by: 1}, {...valid, ahead_by: 0}, Object.assign(new Error('compare denied'), {status: 403})]) {
    const {github, writes} = publicGithub({comparison});
    await assert.rejects(desktop.publishRelease({github, core, context, releaseCommit: ancestor, directory: fixture.directory}));
    assert.deepEqual(writes, []);
  }
  const {github, writes, comparisons} = publicGithub({comparison: valid});
  await desktop.publishRelease({github, core, context, releaseCommit: ancestor, directory: fixture.directory});
  assert.equal(comparisons.length, 1);
  assert.deepEqual(writes, []);
});

test('desktop identical release commit needs no comparison and new tags default to main', async t => {
  const fixture = await verifiedFixture(t);
  const {github, writes, comparisons} = publicGithub();
  await desktop.publishRelease({github, core, context, releaseCommit: context.sha, directory: fixture.directory, dryRun: false});
  assert.deepEqual(comparisons, []);
  assert.equal(writes.find(([type]) => type === 'tag')[1].sha, context.sha);
  assert.equal(writes.find(([type]) => type === 'create')[1].target_commitish, context.sha);
});

test('desktop ancestor anchor cannot move a mismatching tag or publish after its tag changes', async t => {
  const fixture = await verifiedFixture(t);
  const releaseCommit = 'c'.repeat(40);
  const comparison = {status: 'ahead', base_commit: {sha: releaseCommit}, merge_base_commit: {sha: releaseCommit}, ahead_by: 1, behind_by: 0};
  const mismatch = publicGithub({tag: publicCommit, comparison});
  await assert.rejects(desktop.publishRelease({github: mismatch.github, core, context, releaseCommit,
    directory: fixture.directory, dryRun: false}), /immutable/);
  assert.deepEqual(mismatch.writes, []);
  const changed = publicGithub({tag: releaseCommit, existing: true, comparison});
  let reads = 0;
  changed.github.rest.git.getRef = async () => ({data: {object: {type: 'commit', sha: ++reads === 1 ? releaseCommit : publicCommit}}});
  await assert.rejects(desktop.publishRelease({github: changed.github, core, context, releaseCommit,
    directory: fixture.directory, dryRun: false}), /changed before completion/);
  assert.equal(changed.writes.some(([type]) => type === 'tag' || type === 'publish'), false);
});


test('desktop native build pins and client crate version cannot be substituted', () => {
  for (const nativeBuildInputs of [undefined, {}, {...profile.nativeBuildInputs, extra: true},
    ...Object.keys(profile.nativeBuildInputs).flatMap(key => {
      const missing = {...profile.nativeBuildInputs}; delete missing[key];
      return [missing, {...profile.nativeBuildInputs, [key]: 'wrong'}, {...profile.nativeBuildInputs, [key]: null}];
    })]) {
    assert.throws(() => desktop.validateProfile({...profile, nativeBuildInputs}), /profile/);
  }
  assert.throws(() => desktop.validateProfile({...profile, crateVersion: '0.2.0'}), /profile/);
});

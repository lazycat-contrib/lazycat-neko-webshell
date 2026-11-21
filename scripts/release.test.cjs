const {test} = require('node:test');
const assert = require('node:assert/strict');
const {validateRun, ensureAsset, publishedAssetURL, findRelease} = require('./release.cjs');

const trusted = {workflow_id: 42, head_branch: 'main', head_repository: {full_name: 'owner/private'}, event: 'push', conclusion: 'success'};
test('accepts the trusted successful source workflow only', () => {
  validateRun(trusted, 'owner/private', 'main', 42);
  for (const changed of [{event: 'pull_request'}, {head_branch: 'feature'}, {workflow_id: 10}, {conclusion: 'failure'}, {head_repository: {full_name: 'other/fork'}}]) {
    assert.throws(() => validateRun({...trusted, ...changed}, 'owner/private', 'main', 42));
  }
});
test('same-version remote asset cannot be silently overwritten', async () => {
  const github = {request: async () => ({data: Buffer.from('old bytes')})};
  await assert.rejects(() => ensureAsset(github, 'owner', 'public', 10, [{id: 1, name: 'app.lpk'}], 'app.lpk', Buffer.from('new bytes')), /never overwritten/);
});
test('same verified bytes can be reused on retries', async () => {
  const bytes = Buffer.from('same bytes');
  const github = {request: async () => ({data: bytes})};
  const asset = await ensureAsset(github, 'owner', 'public', 10, [{id: 1, name: 'app.lpk'}], 'app.lpk', bytes);
  assert.equal(asset.id, 1);
});

test('store URL comes from refreshed published asset metadata', async () => {
  const canonical = 'https://github.com/owner/public/releases/download/v0.1.1/app.lpk';
  const github = {rest: {repos: {getReleaseAsset: async request => {
    assert.equal(request.asset_id, 17);
    return {data: {browser_download_url: canonical}};
  }}}};
  assert.equal(await publishedAssetURL(github, 'owner', 'public', 17, 'v0.1.1', 'app.lpk'), canonical);
});

test('a temporary draft URL cannot reach a store', async () => {
  const github = {rest: {repos: {getReleaseAsset: async () => ({data: {
    browser_download_url: 'https://github.com/owner/public/releases/download/untagged-123/app.lpk',
  }})}}};
  await assert.rejects(() => publishedAssetURL(github, 'owner', 'public', 17, 'v0.1.1', 'app.lpk'), /published version URL/);
});

test('publication resumes the exact draft with its prepared store notes', async () => {
  const draft = {id: 9, tag_name: 'v0.1.9', draft: true, body: 'Notes for both stores'};
  const releases = [{tag_name: 'v0.1.8', draft: false}, draft];
  const listReleases = () => {};
  const github = {rest: {repos: {listReleases}}, paginate: async (method, request) => {
    assert.equal(method, listReleases);
    assert.deepEqual(request, {owner: 'owner', repo: 'public', per_page: 100});
    return releases;
  }};
  assert.equal(await findRelease(github, 'owner', 'public', 'v0.1.9'), draft);
  assert.equal(await findRelease(github, 'owner', 'public', 'v0.1.8'), releases[0]);
  assert.equal(await findRelease(github, 'owner', 'public', 'v0.2.0'), undefined);
  releases.push({...draft, id: 10});
  await assert.rejects(findRelease(github, 'owner', 'public', 'v0.1.9'), /Multiple releases/);
});

test('client/server source tags cannot cross their component boundary', () => {
  validateRun({...trusted, head_branch: 'client-v0.1.57'}, 'owner/private', 'main', 42, 'client-v');
  assert.throws(() => validateRun({...trusted, head_branch: 'server-v0.1.67'}, 'owner/private', 'main', 42, 'client-v'));
});

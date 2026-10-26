const {test} = require('node:test');
const assert = require('node:assert/strict');
const {validateRun, ensureAsset, publishedAssetURL} = require('./release.cjs');

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

test('client/server source tags cannot cross their component boundary', () => {
  validateRun({...trusted, head_branch: 'client-v0.1.57'}, 'owner/private', 'main', 42, 'client-v');
  assert.throws(() => validateRun({...trusted, head_branch: 'server-v0.1.67'}, 'owner/private', 'main', 42, 'client-v'));
});

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {latestStable, select} = require('./neko-source.cjs');

test('schedule selects the latest stable WebShell version across tag families', () => {
  const names = ['v0.9.99', 'v0.15.11', 'v0.15.2', 'v1.0.0-rc1', 'neoko-terminal-desktop-v9.0.0'];
  assert.equal(latestStable(names.map(name => ({name}))), 'v0.15.11');
});

test('manual retry pins the public tag and reuses the exact package from a draft', async t => {
  const oldTag = process.env.SOURCE_TAG;
  process.env.SOURCE_TAG = 'v0.15.4';
  t.after(() => { if (oldTag === undefined) delete process.env.SOURCE_TAG; else process.env.SOURCE_TAG = oldTag; });
  const outputs = {};
  const github = {
    rest: {repos: {getCommit: async request => {
      assert.deepEqual(request, {owner: 'ca-x', repo: 'lazycat-neko-webshell', ref: 'refs/tags/v0.15.4'});
      return {data: {sha: 'source-commit'}};
    }, listReleases() {}}},
    paginate: async () => [{tag_name: 'v0.15.4', draft: true, assets: [
      {name: 'community.lazycat.webshell.neko-v0.15.4.lpk', id: 123},
    ]}],
  };
  await select({github, context: {eventName: 'workflow_dispatch', repo: {owner: 'lazycat-contrib', repo: 'lazycat-neko-webshell'}},
    core: {setOutput: (key, value) => { outputs[key] = value; }, notice() {}}});
  assert.deepEqual(outputs, {version: '0.15.4', sha: 'source-commit', asset: '123'});
});

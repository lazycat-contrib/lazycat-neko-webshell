const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function profile() {
  const component = process.env.COMPONENT;
  if (!['neko', 'client', 'server'].includes(component)) throw new Error('Unknown application component');
  return JSON.parse(fs.readFileSync(`components/${component}/profile.json`, 'utf8'));
}
const semver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
function validateRun(run, repository, branch, workflowID, tagPrefix) {
  const tag = tagPrefix && run.head_branch?.startsWith(tagPrefix) && semver.test(run.head_branch.slice(tagPrefix.length));
  if (run.workflow_id !== workflowID || !(run.head_branch === branch || tag) ||
      run.head_repository?.full_name?.toLowerCase() !== repository.toLowerCase() ||
      !['push', 'workflow_dispatch'].includes(run.event) || run.conclusion !== 'success') {
    throw new Error('Expected a successful trusted source workflow, branch or release tag; PR/fork builds are rejected');
  }
}

async function selectSource({github, core}) {
  const p = profile();
  const repository = process.env.SOURCE_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '')) throw new Error('Set the LPK_SOURCE_REPOSITORY Actions secret');
  const [owner, repo] = repository.split('/');
  const branch = process.env.SOURCE_BRANCH || 'main';
  const workflow = await github.rest.actions.getWorkflow({owner, repo, workflow_id: p.workflow});
  const requested = process.env.SOURCE_RUN_ID || '';
  let candidates;
  if (requested) {
    if (!/^[1-9]\d*$/.test(requested) || !Number.isSafeInteger(Number(requested))) throw new Error('Invalid source run ID');
    candidates = [(await github.rest.actions.getWorkflowRun({owner, repo, run_id: Number(requested)})).data];
  } else {
    candidates = (await github.rest.actions.listWorkflowRuns({owner, repo, workflow_id: workflow.data.id, status: 'success', per_page: 30})).data.workflow_runs;
  }
  for (const run of candidates) {
    try { validateRun(run, repository, branch, workflow.data.id, p.tagPrefix); }
    catch (error) { if (requested) throw error; continue; }
    const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, {owner, repo, run_id: run.id, per_page: 100});
    const matches = artifacts.filter(a => !a.expired && a.name.startsWith(p.artifactPrefix) && semver.test(a.name.slice(p.artifactPrefix.length)));
    if (matches.length !== 1) { if (requested) throw new Error('Expected exactly one unexpired component LPK artifact'); continue; }
    const version = matches[0].name.slice(p.artifactPrefix.length);
    if (run.head_branch !== branch && run.head_branch !== p.tagPrefix + version) throw new Error('Artifact version differs from the source release tag');
    core.setOutput('available', 'true');
    core.setOutput('run-id', String(run.id));
    core.setOutput('artifact-name', matches[0].name);
    core.setOutput('version', version);
    core.setOutput('package-id', p.packageId);
    core.setOutput('tag', p.tagPrefix + version);
    core.setOutput('official', String(p.official));
    return;
  }
  core.setOutput('available', 'false');
  core.notice('No unexpired component LPK is available; waiting for the next private build.');
}

async function assetBytes(github, owner, repo, asset) {
  const response = await github.request('GET /repos/{owner}/{repo}/releases/assets/{asset_id}', {
    owner, repo, asset_id: asset.id, headers: {accept: 'application/octet-stream'},
  });
  return Buffer.from(response.data);
}

async function ensureAsset(github, owner, repo, releaseID, existing, name, bytes) {
  const wanted = 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
  let asset = existing.find(a => a.name === name);
  if (!asset) {
    asset = (await github.rest.repos.uploadReleaseAsset({
      owner, repo, release_id: releaseID, name, data: bytes,
      headers: {'content-type': 'application/octet-stream', 'content-length': bytes.length},
    })).data;
  }
  // Read back the actual remote bytes, including when recovering a partial run.
  const actual = 'sha256:' + crypto.createHash('sha256').update(await assetBytes(github, owner, repo, asset)).digest('hex');
  if (wanted !== actual) throw new Error(`Release asset ${name} differs from the verified LPK/checksum; existing assets are never overwritten`);
  return asset;
}

async function publishedAssetURL(github, owner, repo, assetID, tag, filename) {
  // Draft assets have temporary /untagged-* URLs. Read fresh metadata only
  // after the Release is published; never pass the draft response to a store.
  const {data: asset} = await github.rest.repos.getReleaseAsset({owner, repo, asset_id: assetID});
  const url = new URL(asset.browser_download_url);
  const expected = `/${owner}/${repo}/releases/download/${tag}/${filename}`;
  if (url.origin !== (process.env.GITHUB_SERVER_URL || 'https://github.com') ||
      decodeURIComponent(url.pathname) !== expected || url.search || url.hash) {
    throw new Error('Release asset does not have the expected published version URL');
  }
  return asset.browser_download_url;
}

async function publishRelease({github, context, core}) {
  const {owner, repo} = context.repo;
  const version = process.env.LPK_VERSION;
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version || '')) throw new Error('Invalid release version');
  const p = profile();
  const tag = p.tagPrefix + version;
  let release;
  try {
    release = (await github.rest.repos.getReleaseByTag({owner, repo, tag})).data;
  } catch (error) {
    if (error.status !== 404) throw error;
    release = (await github.rest.repos.createRelease({
      owner, repo, tag_name: tag, target_commitish: context.sha, draft: true,
      name: `${p.name} ${tag}`,
      body: `${p.name} ${tag}\n\n更新至 ${version}。\n\n提供 LPK 安装包及 SHA256 校验文件。`,
    })).data;
  }
  const assets = await github.paginate(github.rest.repos.listReleaseAssets, {owner, repo, release_id: release.id, per_page: 100});
  const lpk = fs.readFileSync(process.env.LPK_PATH);
  if (crypto.createHash('sha256').update(lpk).digest('hex') !== process.env.LPK_SHA256) throw new Error('Local LPK changed after validation');
  const filename = `${p.packageId}-v${version}.lpk`;
  const asset = await ensureAsset(github, owner, repo, release.id, assets, filename, lpk);
  await ensureAsset(github, owner, repo, release.id, assets, 'checksums.txt', fs.readFileSync(path.join(path.dirname(process.env.LPK_PATH), 'checksums.txt')));
  if (release.draft) release = (await github.rest.repos.updateRelease({owner, repo, release_id: release.id, draft: false})).data;
  core.setOutput('download-url', await publishedAssetURL(github, owner, repo, asset.id, tag, filename));
  core.setOutput('changelog', release.body || `Release ${version}`);
  core.summary.addHeading('LPK published').addTable([
    [{data: 'Package', header: true}, {data: 'Version', header: true}, {data: 'SHA256', header: true}],
    [p.packageId, version, process.env.LPK_SHA256],
  ]).addLink('GitHub Release', release.html_url);
  await core.summary.write();
}

module.exports = {profile, validateRun, selectSource, ensureAsset, publishedAssetURL, publishRelease};

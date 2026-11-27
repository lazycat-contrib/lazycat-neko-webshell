const {findRelease} = require('./release.cjs');
const stable = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const qualified = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const source = {owner: 'ca-x', repo: 'lazycat-neko-webshell'};

function latestStable(tags) {
  return tags.map(t => t.name).filter(name => stable.test(name)).sort((a, b) =>
    b.localeCompare(a, 'en', {numeric: true}))[0];
}

async function select({github, context, core}) {
  const requested = process.env.SOURCE_TAG || '';
  const tag = requested || latestStable(await github.paginate(github.rest.repos.listTags, {...source, per_page: 100}));
  if (!qualified.test(tag || '')) throw new Error('Expected a WebShell vX.Y.Z source tag');
  const {data: commit} = await github.rest.repos.getCommit({...source, ref: 'refs/tags/' + tag});
  const {owner, repo} = context.repo;
  const release = await findRelease(github, owner, repo, tag);
  if (context.eventName === 'schedule' && release && !release.draft) {
    core.notice(tag + ' is already published');
    return;
  }
  const version = tag.slice(1);
  const asset = release?.assets.find(a => a.name === 'community.lazycat.webshell.neko-v' + version + '.lpk');
  core.setOutput('version', version);
  core.setOutput('sha', commit.sha);
  core.setOutput('asset', asset ? String(asset.id) : '');
  core.notice('Selected ' + tag + ' at ' + commit.sha);
}
module.exports = {select, latestStable};

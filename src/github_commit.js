const logger = require('./utils/logger');

function githubContentsUrl(repo, filePath) {
  return 'https://api.github.com/repos/' + repo + '/contents/' + filePath;
}

function encodeContentBase64(content) {
  return Buffer.from(String(content), 'utf8').toString('base64');
}

function buildPutBody({ content, branch, sha, message }) {
  const body = {
    message,
    content: encodeContentBase64(content),
    branch
  };
  if (sha) body.sha = sha;
  return body;
}

// Commit a single file to the configured GitHub repo via the Contents API.
// Mirrors the inline flow in api/dashboard.js POST /prompts/:name so the apply
// path uses the same mechanism. Returns { committed, commit_sha?, html_url?,
// git_error? }. Throws only on an unexpected GitHub error after a token exists.
async function commitFileToGitHub({ filePath, content, message }) {
  const repo = process.env.GITHUB_REPO || 'sergeadaimy-hash/sunny-electrosun';
  const branch = process.env.GITHUB_BRANCH || 'main';
  const token = process.env.GITHUB_TOKEN;
  const result = { committed: false };

  if (!token) {
    result.git_error = 'GITHUB_TOKEN env var is not set; change applies to this container only and will be lost on next git redeploy.';
    return result;
  }

  const headers = {
    'Authorization': 'Bearer ' + token,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'sunny-electrosun-admin'
  };
  const apiBase = githubContentsUrl(repo, filePath);

  const getRes = await fetch(apiBase + '?ref=' + encodeURIComponent(branch), { headers });
  let sha = null;
  if (getRes.ok) {
    const meta = await getRes.json();
    sha = meta.sha;
  } else if (getRes.status !== 404) {
    const t = await getRes.text();
    throw new Error('GitHub GET ' + getRes.status + ': ' + t.slice(0, 200));
  }

  const putRes = await fetch(apiBase, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildPutBody({ content, branch, sha, message }))
  });
  if (!putRes.ok) {
    const t = await putRes.text();
    throw new Error('GitHub PUT ' + putRes.status + ': ' + t.slice(0, 300));
  }
  const putJson = await putRes.json();
  result.committed = true;
  result.commit_sha = putJson.commit && putJson.commit.sha;
  result.html_url = putJson.content && putJson.content.html_url;
  logger.info('github_commit.ok', { filePath, commit_sha: result.commit_sha });
  return result;
}

module.exports = { githubContentsUrl, encodeContentBase64, buildPutBody, commitFileToGitHub };

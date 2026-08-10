import type { APIRoute } from "astro";
import { z } from "zod";
import {
  GitHubError,
  assertSameOrigin,
  getSession,
  githubConfig,
  githubFetch,
  jsonResponse,
} from "../../../lib/github";

const assetSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|gif|webp)$/i),
  contentBase64: z.string().max(8_000_000),
});

const requestSchema = z.object({
  path: z.string().regex(/^pages\/[a-z0-9]+(?:-[a-z0-9]+)*\/index\.md$/),
  content: z.string().min(1).max(1_000_000),
  baseCommitSha: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  title: z.string().min(1).max(100),
  description: z.string().max(500).default(""),
  assets: z.array(assetSchema).max(20).default([]),
});

interface RefResponse { object: { sha: string } }
interface CommitResponse { tree: { sha: string } }
interface BlobResponse { sha: string }
interface TreeResponse { sha: string }
interface CreatedCommit { sha: string; html_url: string }

function utf8Base64(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function createCommit(options: {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  expectedCommitSha?: string;
  message: string;
  files: Array<{ path: string; contentBase64: string }>;
}) {
  const { token, owner, repo, branch, expectedCommitSha, message, files } = options;
  const ref = await githubFetch<RefResponse>(token, `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
  if (expectedCommitSha && ref.object.sha !== expectedCommitSha) {
    throw new GitHubError(409, "The page changed after editing started. Reload it before saving.");
  }
  const base = await githubFetch<CommitResponse>(token, `/repos/${owner}/${repo}/git/commits/${ref.object.sha}`);
  const entries = await Promise.all(files.map(async (file) => {
    const blob = await githubFetch<BlobResponse>(token, `/repos/${owner}/${repo}/git/blobs`, {
      method: "POST",
      body: JSON.stringify({ content: file.contentBase64, encoding: "base64" }),
    });
    return { path: file.path, mode: "100644", type: "blob", sha: blob.sha };
  }));
  const tree = await githubFetch<TreeResponse>(token, `/repos/${owner}/${repo}/git/trees`, {
    method: "POST",
    body: JSON.stringify({ base_tree: base.tree.sha, tree: entries }),
  });
  const commit = await githubFetch<CreatedCommit>(token, `/repos/${owner}/${repo}/git/commits`, {
    method: "POST",
    body: JSON.stringify({ message, tree: tree.sha, parents: [ref.object.sha] }),
  });
  await githubFetch(token, `/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });
  return commit;
}

async function ensureFork(token: string, login: string, owner: string, repo: string, branch: string) {
  let fork: { full_name: string; parent?: { full_name: string } } | null = null;
  try {
    fork = await githubFetch<{ full_name: string; parent?: { full_name: string } }>(token, `/repos/${login}/${repo}`);
    if (fork.parent?.full_name.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) {
      throw new GitHubError(409, `${login}/${repo} exists but is not a fork of ${owner}/${repo}.`);
    }
  } catch (error) {
    if (!(error instanceof GitHubError) || error.status !== 404) throw error;
    await githubFetch(token, `/repos/${owner}/${repo}/forks`, { method: "POST", body: "{}" });
    for (let attempt = 0; attempt < 8; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 750));
      try {
        fork = await githubFetch<{ full_name: string; parent?: { full_name: string } }>(token, `/repos/${login}/${repo}`);
        break;
      } catch (pollError) {
        if (!(pollError instanceof GitHubError) || pollError.status !== 404) throw pollError;
      }
    }
  }
  if (!fork) throw new GitHubError(503, "GitHub is still creating the fork. Try saving again shortly.");
  try {
    await githubFetch(token, `/repos/${login}/${repo}/merge-upstream`, {
      method: "POST",
      body: JSON.stringify({ branch }),
    });
  } catch (error) {
    if (!(error instanceof GitHubError) || ![409, 422].includes(error.status)) throw error;
  }
}

export const POST: APIRoute = async ({ request }) => {
  try {
    assertSameOrigin(request);
    const session = await getSession(request);
    if (!session) return jsonResponse({ error: "GitHub login is required" }, 401);
    if (request.headers.get("x-csrf-token") !== session.csrfToken) {
      return jsonResponse({ error: "Invalid CSRF token" }, 403);
    }
    const input = requestSchema.parse(await request.json());
    const { owner, repo, branch } = githubConfig();
    const repository = await githubFetch<{ permissions?: { push?: boolean } }>(session.accessToken, `/repos/${owner}/${repo}`);
    const pageDir = input.path.slice(0, -"index.md".length);
    const files = [
      { path: input.path, contentBase64: utf8Base64(input.content) },
      ...input.assets.map((asset) => ({ path: `${pageDir}assets/${asset.name}`, contentBase64: asset.contentBase64 })),
    ];
    const message = `docs: ${input.title}`;

    if (repository.permissions?.push) {
      const commit = await createCommit({
        token: session.accessToken,
        owner,
        repo,
        branch,
        expectedCommitSha: input.baseCommitSha,
        message,
        files,
      });
      return jsonResponse({ mode: "direct", commitUrl: commit.html_url, redirectUrl: `/${input.path.split("/")[1]}/` });
    }

    await ensureFork(session.accessToken, session.user.login, owner, repo, branch);
    const forkRef = await githubFetch<RefResponse>(session.accessToken, `/repos/${session.user.login}/${repo}/git/ref/heads/${branch}`);
    const editBranch = `editor/${session.user.login}/${Date.now()}`;
    await githubFetch(session.accessToken, `/repos/${session.user.login}/${repo}/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${editBranch}`, sha: forkRef.object.sha }),
    });
    await createCommit({
      token: session.accessToken,
      owner: session.user.login,
      repo,
      branch: editBranch,
      message,
      files,
    });
    const compare = new URL(`https://github.com/${owner}/${repo}/compare/${branch}...${session.user.login}:${editBranch}`);
    compare.searchParams.set("quick_pull", "1");
    compare.searchParams.set("title", input.title);
    compare.searchParams.set("body", input.description || "WYSIWYGエディターからの更新提案です。");
    return jsonResponse({ mode: "pull-request", redirectUrl: compare.toString() });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof z.ZodError) return jsonResponse({ error: "入力内容を確認してください", issues: error.issues }, 400);
    if (error instanceof GitHubError) return jsonResponse({ error: error.message }, error.status);
    console.error(error);
    return jsonResponse({ error: "保存処理に失敗しました" }, 500);
  }
};

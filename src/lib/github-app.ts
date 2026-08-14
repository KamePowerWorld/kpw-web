import { createPrivateKey, sign } from "node:crypto";
import { runtimeEnv } from "./runtime";

export const githubConfig = () => ({
  owner: runtimeEnv.GITHUB_OWNER || "KamePowerWorld",
  repo: runtimeEnv.GITHUB_REPO || "kpw-docs",
  branch: runtimeEnv.GITHUB_BRANCH || "master",
});

export class GitHubError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "GitHubError";
  }
}

function encode(value: object) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function bytesToBase64Url(value: Uint8Array) {
  return btoa(String.fromCharCode(...value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function appJwt() {
  if (!runtimeEnv.GITHUB_APP_ID || !runtimeEnv.GITHUB_APP_PRIVATE_KEY) throw new GitHubError(503, "GitHub App is not configured");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 9 * 60, iss: runtimeEnv.GITHUB_APP_ID })}`;
  const signature = bytesToBase64Url(sign("RSA-SHA256", Buffer.from(unsigned), createPrivateKey(runtimeEnv.GITHUB_APP_PRIVATE_KEY)));
  return `${unsigned}.${signature}`;
}

async function rawGitHubFetch<T>(authorization: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${authorization}`,
      "User-Agent": "KamePowerWorld-kpw-web",
      "X-GitHub-Api-Version": "2026-03-10",
      ...init.headers,
    },
  });
  if (!response.ok) {
    const details = (await response.text()).slice(0, 8_000);
    throw new GitHubError(response.status, details || response.statusText);
  }
  return response.status === 204 ? undefined as T : await response.json<T>();
}

export async function getInstallationToken() {
  const jwt = appJwt();
  const { owner, repo } = githubConfig();
  let installationId: string = runtimeEnv.GITHUB_INSTALLATION_ID;
  if (!installationId) {
    const installation = await rawGitHubFetch<{ id: number }>(jwt, `/repos/${owner}/${repo}/installation`);
    installationId = String(installation.id);
  }
  const result = await rawGitHubFetch<{ token: string }>(jwt, `/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repositories: [repo], permissions: { contents: "write" } }),
  });
  return result.token;
}

export async function githubFetch<T>(token: string, path: string, init: RequestInit = {}) {
  return rawGitHubFetch<T>(token, path, init);
}

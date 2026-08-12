import { env } from "cloudflare:workers";

export type CloudflareEnv = Env;
export const runtimeEnv = env as CloudflareEnv;

export interface GitHubSession {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  csrfToken: string;
  user: { login: string; name: string | null; avatarUrl: string };
}

interface GitHubInstallation {
  id: number;
  app_slug: string;
  account?: { login?: string };
  html_url?: string;
  repository_selection: "all" | "selected";
}

export async function getInstallationAccess(token: string, account: string, repo: string) {
  const response = await githubFetch<{ installations: GitHubInstallation[] }>(token, "/user/installations?per_page=100");
  const installation = response.installations.find((item) =>
    item.app_slug === "kamepowerworldeditor"
    && item.account?.login?.toLowerCase() === account.toLowerCase());
  const installUrl = "https://github.com/apps/kamepowerworldeditor/installations/new";
  if (!installation) return { ready: false as const, actionUrl: installUrl };
  if (installation.repository_selection === "all") {
    return { ready: true as const, actionUrl: installation.html_url ?? installUrl };
  }
  const repositories = await githubFetch<{ repositories: Array<{ name: string }> }>(
    token,
    `/user/installations/${installation.id}/repositories?per_page=100`,
  );
  return {
    ready: repositories.repositories.some((item) => item.name.toLowerCase() === repo.toLowerCase()),
    actionUrl: installation.html_url ?? installUrl,
  };
}

export const githubConfig = () => ({
  owner: runtimeEnv.GITHUB_OWNER || "KamePowerWorld",
  repo: runtimeEnv.GITHUB_REPO || "kpw-docs",
  branch: runtimeEnv.GITHUB_BRANCH || "master",
});

export function parseCookies(request: Request) {
  return Object.fromEntries(
    (request.headers.get("cookie") ?? "")
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([key, value]) => key && value)
      .map(([key, ...value]) => [key, decodeURIComponent(value.join("="))]),
  );
}

export function sessionCookie(id: string, maxAge = 8 * 60 * 60) {
  return `kpw_session=${encodeURIComponent(id)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export async function getSession(request: Request): Promise<GitHubSession | null> {
  const sessionId = parseCookies(request).kpw_session;
  if (!sessionId) return null;
  const session = await runtimeEnv.SESSIONS.get<GitHubSession>(`session:${sessionId}`, "json");
  if (!session || session.expiresAt <= Date.now()) return null;
  return session;
}

export async function githubFetch<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "KamePowerWorld-kpw-web",
      "X-GitHub-Api-Version": "2026-03-10",
      ...init.headers,
    },
  });

  if (!response.ok) {
    const details = await response.text();
    throw new GitHubError(response.status, details || response.statusText);
  }
  return response.status === 204 ? undefined as T : await response.json() as T;
}

export class GitHubError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "GitHubError";
  }
}

export function secureRandom(bytes = 24) {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return btoa(String.fromCharCode(...value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function jsonResponse(data: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    throw new Response("Invalid origin", { status: 403 });
  }
}

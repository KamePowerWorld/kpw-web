import { env } from "cloudflare:workers";

export interface CloudflareEnv {
  ASSETS: Fetcher;
  SESSIONS: KVNamespace;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_OWNER?: string;
  GITHUB_REPO?: string;
  GITHUB_BRANCH?: string;
}

export const runtimeEnv = env as unknown as CloudflareEnv;

export interface GitHubSession {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  csrfToken: string;
  user: { login: string; name: string | null; avatarUrl: string };
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

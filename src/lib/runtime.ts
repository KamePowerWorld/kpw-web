import { env } from "cloudflare:workers";

type ConfiguredNames = "DISCORD_CLIENT_ID" | "DISCORD_GUILD_ID" | "DISCORD_ADMIN_ROLE_ID" | "GITHUB_APP_ID" | "GITHUB_APP_SLUG" | "GITHUB_INSTALLATION_ID";
export type RuntimeEnv = Omit<Cloudflare.Env, ConfiguredNames> & Record<ConfiguredNames, string>;

export const runtimeEnv = env as RuntimeEnv;

export interface DiscordSession {
  csrfToken: string;
  expiresAt: number;
  user: { id: string; username: string; displayName: string; avatarUrl: string };
}

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
  return `kpw_discord_session=${encodeURIComponent(id)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export async function getSession(request: Request): Promise<DiscordSession | null> {
  const sessionId = parseCookies(request).kpw_discord_session;
  if (!sessionId) return null;
  const session = await runtimeEnv.SESSIONS.get<DiscordSession>(`discord-session:${sessionId}`, "json");
  if (!session || session.expiresAt <= Date.now()) return null;
  return session;
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
  if (origin && origin !== new URL(request.url).origin) throw new Response("Invalid origin", { status: 403 });
}

export async function requireCsrf(request: Request) {
  const session = await getSession(request);
  if (!session) throw new Response("Discord login is required", { status: 401 });
  if (request.headers.get("x-csrf-token") !== session.csrfToken) throw new Response("Invalid CSRF token", { status: 403 });
  return session;
}

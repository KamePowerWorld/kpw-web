import { getSession, runtimeEnv, type DiscordSession } from "./runtime";

const apiBase = "https://discord.com/api/v10";

export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
}

export interface DiscordMember {
  user?: DiscordUser;
  nick?: string | null;
  roles: string[];
  pending?: boolean;
}

export interface DiscordRole {
  id: string;
  name: string;
  color: number;
  managed: boolean;
  position: number;
}

export class DiscordError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "DiscordError";
  }
}

async function discordFetch<T>(path: string, authorization: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: { Accept: "application/json", Authorization: authorization, ...init.headers },
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 2_000);
    throw new DiscordError(response.status, detail || response.statusText);
  }
  return response.status === 204 ? undefined as T : await response.json<T>();
}

export function avatarUrl(user: DiscordUser) {
  return user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`
    : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(user.id) >> 22n) % 6}.png`;
}

export async function getOAuthUser(accessToken: string) {
  return discordFetch<DiscordUser>("/users/@me", `Bearer ${accessToken}`);
}

export async function getGuildMember(userId: string) {
  if (!runtimeEnv.DISCORD_BOT_TOKEN || !runtimeEnv.DISCORD_GUILD_ID) throw new DiscordError(503, "Discord Bot is not configured");
  return discordFetch<DiscordMember>(`/guilds/${runtimeEnv.DISCORD_GUILD_ID}/members/${userId}`, `Bot ${runtimeEnv.DISCORD_BOT_TOKEN}`);
}

export async function getGuildRoles() {
  if (!runtimeEnv.DISCORD_BOT_TOKEN || !runtimeEnv.DISCORD_GUILD_ID) throw new DiscordError(503, "Discord Bot is not configured");
  return discordFetch<DiscordRole[]>(`/guilds/${runtimeEnv.DISCORD_GUILD_ID}/roles`, `Bot ${runtimeEnv.DISCORD_BOT_TOKEN}`);
}

export async function searchGuildMembers(query: string) {
  if (!runtimeEnv.DISCORD_BOT_TOKEN || !runtimeEnv.DISCORD_GUILD_ID) throw new DiscordError(503, "Discord Bot is not configured");
  return discordFetch<DiscordMember[]>(`/guilds/${runtimeEnv.DISCORD_GUILD_ID}/members/search?query=${encodeURIComponent(query)}&limit=20`, `Bot ${runtimeEnv.DISCORD_BOT_TOKEN}`);
}

export type LiveIdentity = { session: DiscordSession; member: DiscordMember; roleIds: string[]; isAdmin: boolean };

export async function getLiveIdentity(request: Request): Promise<LiveIdentity | null> {
  const session = await getSession(request);
  if (!session) return null;
  try {
    const member = await getGuildMember(session.user.id);
    if (member.pending) return null;
    return {
      session,
      member,
      roleIds: [runtimeEnv.DISCORD_GUILD_ID, ...member.roles],
      isAdmin: Boolean(runtimeEnv.DISCORD_ADMIN_ROLE_ID && member.roles.includes(runtimeEnv.DISCORD_ADMIN_ROLE_ID)),
    };
  } catch (error) {
    if (error instanceof DiscordError && error.status === 404) return null;
    throw error;
  }
}

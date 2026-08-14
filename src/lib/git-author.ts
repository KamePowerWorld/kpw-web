export function discordGitAuthor(user: { id: string; username: string }) {
  const name = user.username.replace(/[\r\n<>]/g, "").trim() || "discord-user";
  return { name: name.slice(0, 100), email: `discord-${user.id}@kamepowerworld.invalid` };
}

export function githubAppCommitter(bot: { id: number; login: string }) {
  return { name: bot.login, email: `${bot.id}+${bot.login}@users.noreply.github.com` };
}

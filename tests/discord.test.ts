import assert from "node:assert/strict";
import test from "node:test";
import { discordGitAuthor, githubAppCommitter } from "../src/lib/git-author";

test("Git author uses the stable Discord username instead of nickname or numeric ID", () => {
  const user = { id: "100000000000000001", username: "kamesuta", displayName: "かめっち", avatarUrl: "https://example.invalid/avatar.png" };
  const author = discordGitAuthor(user);
  assert.equal(author.name, "kamesuta");
  assert.doesNotMatch(author.name, /かめっち|100000000000000001/);
  assert.equal(author.email, "discord-100000000000000001@kpw.local");
});

test("Git author strips commit header delimiters from an unexpected username", () => {
  const user = { id: "100000000000000001", username: "bad\n<name>", displayName: "Bad", avatarUrl: "" };
  const author = discordGitAuthor(user);
  assert.equal(author.name, "badname");
});

test("Git committer uses the GitHub App bot identity", () => {
  const committer = githubAppCommitter({ id: 123456, login: "kpw-editor[bot]" });
  assert.equal(committer.name, "kpw-editor[bot]");
  assert.equal(committer.email, "123456+kpw-editor[bot]@users.noreply.github.com");
});

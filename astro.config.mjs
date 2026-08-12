import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";

export default defineConfig({
  output: "server",
  // Middleware owns the canonical 308 so query strings and nested aliases use one policy.
  trailingSlash: "ignore",
  adapter: cloudflare({
    imageService: "compile",
    sessionKVBindingName: "SESSIONS",
  }),
  integrations: [react()],
  vite: {
    ssr: {
      noExternal: ["@milkdown/crepe", "@milkdown/react"],
    },
  },
});

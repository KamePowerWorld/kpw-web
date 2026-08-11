import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";

export default defineConfig({
  output: "server",
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

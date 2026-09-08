import { defineMiddleware } from "astro:middleware";
import { runtimeEnv } from "./lib/runtime";

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname, search } = context.url;
  if (pathname !== "/" && pathname.endsWith("/")) {
    return context.redirect(`${pathname.replace(/\/+$/, "")}${search}`, 308);
  }
  const response = await next();
  // Staging keeps the production canonical URLs, so it must never be indexed on its own.
  if (runtimeEnv.KPW_ENV === "staging") response.headers.set("x-robots-tag", "noindex, nofollow");
  return response;
});

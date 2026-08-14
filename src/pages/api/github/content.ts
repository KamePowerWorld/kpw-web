import type { APIRoute } from "astro";
export const GET: APIRoute = () => new Response("This endpoint was removed", { status: 410 });

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff"
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      if (request.method !== "GET") {
        return json({ ok: false, error: "method_not_allowed" }, 405);
      }

      try {
        const row = await env.DB.prepare("SELECT 1 AS ok").first();
        return json({
          ok: row?.ok === 1,
          service: "citadel-ai",
          database: "citadel-control"
        });
      } catch {
        return json({
          ok: false,
          service: "citadel-ai",
          database: "unavailable"
        }, 503);
      }
    }

    if (url.pathname.startsWith("/api/")) {
      return json({ ok: false, error: "not_found" }, 404);
    }

    return env.ASSETS.fetch(request);
  }
};

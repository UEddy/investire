/**
 * Server side RPC proxy.
 *
 * The browser talks to this route, this route talks to the real endpoint. The
 * endpoint url lives in RPC_URL, which has no NEXT_PUBLIC_ prefix and so is
 * never inlined into the bundle: a provider key in it stays on the server.
 *
 * NEXT_PUBLIC_ is the trap worth being explicit about. It does not mean "a
 * variable the app uses", it means "a value compiled into the JavaScript every
 * visitor downloads". Keeping a key out of git does nothing about that.
 * Keeping it out of the bundle does.
 *
 * Deliberately the Node runtime and not edge. On edge, env access is resolved
 * when the bundle is built, and a variable marked Sensitive in Vercel is not
 * exposed to the build at all, so the value that arrives at runtime is not the
 * one that was compiled in. Node reads process.env when the request is served,
 * which is when the value actually exists.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Host only, for error messages. Never the query string, which holds the key. */
function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unparseable";
  }
}

export async function POST(request: Request): Promise<Response> {
  const raw = process.env.RPC_URL;
  if (!raw) {
    return Response.json(
      { error: "RPC_URL is not configured on the server" },
      { status: 500 },
    );
  }

  // Dashboard values arrive with surrounding quotes often enough to be worth
  // tolerating: a pasted "https://..." is a valid looking entry that fetch
  // rejects as a malformed url, and the failure gives no hint why.
  const upstream = raw.trim().replace(/^["']|["']$/g, "");

  if (!/^https?:\/\//.test(upstream)) {
    return Response.json(
      {
        error:
          "RPC_URL is not an absolute http(s) url. Check for stray quotes or whitespace.",
      },
      { status: 500 },
    );
  }

  const body = await request.text();

  // Only the JSON-RPC body is forwarded. Headers from the browser are dropped
  // rather than passed through, so nothing a visitor sets can reach the
  // provider carrying this deployment's credentials.
  let response: Response;
  try {
    response = await fetch(upstream, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  } catch (err) {
    // Name the host and the reason, never the url: the key is in the query
    // string and this response is public.
    return Response.json(
      {
        error: "the RPC endpoint could not be reached",
        host: safeHost(upstream),
        reason: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }

  if (!response.ok) {
    return Response.json(
      {
        error: "the RPC endpoint rejected the request",
        host: safeHost(upstream),
        status: response.status,
      },
      { status: 502 },
    );
  }

  return new Response(response.body, {
    status: response.status,
    headers: {
      "content-type":
        response.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    },
  });
}

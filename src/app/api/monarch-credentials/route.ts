import { saveMonarchCredentials } from "@/lib/monarch-credentials";

export const dynamic = "force-dynamic";

// Receives a freshly-minted Monarch token from scripts/monarch-refresh.mjs so
// refreshing an expired session is one local command instead of hand-copying
// values into wrangler secret put. No bespoke auth here: this route is
// reached through the same worker.ts request path as every page in the app,
// so it is already behind Cloudflare Access — locally (npm run dev) Access is
// skipped entirely, matching every other route's enforcement.
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { token, deviceUuid } = (body ?? {}) as Record<string, unknown>;
  if (typeof token !== "string" || !token || typeof deviceUuid !== "string" || !deviceUuid) {
    return Response.json(
      { error: "expected { token: string, deviceUuid: string }" },
      { status: 400 },
    );
  }

  await saveMonarchCredentials({ token, deviceUuid });
  return Response.json({ ok: true });
}

import { eq } from "drizzle-orm";
import { db, appConfig } from "@/db";

// Where the Monarch API token lives once minted: a row in the existing
// app_config table (see scripts/monarch-refresh.mjs for how it gets there).
// Not a Cloudflare Worker secret — that would require `wrangler secret put`
// (and effectively a redeploy-shaped step) every time Monarch's session
// expires, which is undocumented and can be as short as hours. Storing it as
// application data means refreshing it is a normal authenticated write, no
// different from any other Fred mutation.

const KEY = "monarch_credentials";

export type MonarchCredentials = { token: string; deviceUuid: string };

type StoredValue = MonarchCredentials & { refreshedAt: string };

function isStoredValue(v: unknown): v is StoredValue {
  const o = v as Partial<StoredValue> | null;
  return (
    !!o &&
    typeof o.token === "string" &&
    o.token.length > 0 &&
    typeof o.deviceUuid === "string" &&
    o.deviceUuid.length > 0 &&
    typeof o.refreshedAt === "string"
  );
}

export async function loadMonarchCredentials(): Promise<MonarchCredentials | undefined> {
  const [row] = await db.select().from(appConfig).where(eq(appConfig.key, KEY));
  if (!row || !isStoredValue(row.value)) return undefined;
  return { token: row.value.token, deviceUuid: row.value.deviceUuid };
}

export async function saveMonarchCredentials(creds: MonarchCredentials): Promise<void> {
  const value: StoredValue = { ...creds, refreshedAt: new Date().toISOString() };
  await db
    .insert(appConfig)
    .values({ key: KEY, value })
    .onConflictDoUpdate({ target: appConfig.key, set: { value } });
}

export async function monarchCredentialsStatus(): Promise<{
  configured: boolean;
  refreshedAt: string | null;
}> {
  const [row] = await db.select().from(appConfig).where(eq(appConfig.key, KEY));
  if (!row || !isStoredValue(row.value)) return { configured: false, refreshedAt: null };
  return { configured: true, refreshedAt: row.value.refreshedAt };
}

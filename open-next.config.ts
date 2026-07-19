import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// No incremental cache override: every page is force-dynamic (fresh DB reads),
// so there is no ISR output to persist. Add the R2 incremental cache here if
// static regeneration is ever introduced.
export default defineCloudflareConfig();

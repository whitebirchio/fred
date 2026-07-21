// `.open-next/worker.js` is emitted by `opennextjs-cloudflare build`, so it is
// absent on a fresh clone and unresolvable by tsc. Declaring its shape keeps
// worker.ts type-checked without requiring a build first.
declare module "*/.open-next/worker.js" {
  const handler: {
    fetch(request: Request, env: unknown, ctx: unknown): Promise<Response>;
  };
  export default handler;
}

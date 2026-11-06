// Local test harness: serves the API on http://localhost:8788 against any Postgres.
// Usage: ROOMS_DB_URL=postgres://... ADMIN_SETUP_KEY=... npx tsx tests/server.ts
import { createServer } from "node:http";
import { router } from "../server/routes.js";

const port = Number(process.env.PORT ?? 8788);

export function startServer() {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const url = `http://localhost:${port}${req.url}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const request = new Request(url, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method ?? "GET") ? undefined : Buffer.concat(chunks),
    });
    const response = await router.handle(request, req.socket.remoteAddress ?? "local");
    const out: Record<string, string> = {};
    response.headers.forEach((v, k) => (out[k] = v));
    res.writeHead(response.status, out);
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  return new Promise<typeof server>((resolve) => server.listen(port, () => resolve(server)));
}

if (process.argv[1]?.endsWith("server.ts")) {
  startServer().then(() => console.log(`API listening on http://localhost:${port}`));
}

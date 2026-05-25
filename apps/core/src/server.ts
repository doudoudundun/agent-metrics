import { buildApp } from "./app.js";

const app = buildApp({ dbPath: "data/sqlite/metrics.sqlite" });

app.listen({ host: "127.0.0.1", port: 4318 }).catch((error: unknown) => {
  app.log.error(error as Error);
  process.exit(1);
});

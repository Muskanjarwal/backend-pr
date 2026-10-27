import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { parse } from "yaml";
import { buildApp } from "../src/app.js";
import { createEnv, type Env } from "./helpers.js";

let env: Env;
beforeAll(async () => { env = await createEnv(); });
afterAll(() => env.close());

const spec = parse(readFileSync(new URL("../openapi/openapi.yaml", import.meta.url), "utf8"));

/** Fails the build when code and contract drift apart, in either direction. */
it("documents exactly the routes the server exposes", async () => {
  const live = new Set<string>();
  const probe = await buildApp(env.deps, {
    onRoute: ({ method, url }) => {
      for (const m of [method].flat()) if (m !== "HEAD" && m !== "OPTIONS") live.add(`${m} ${url.replace(/:(\w+)/g, "{$1}")}`);
    },
  });
  await probe.ready();
  await probe.close();

  const documented = new Set<string>();
  for (const [path, item] of Object.entries<any>(spec.paths)) for (const m of Object.keys(item)) documented.add(`${m.toUpperCase()} ${path}`);

  expect([...live].filter((r) => !documented.has(r)).sort()).toEqual([]); // implemented but undocumented
  expect([...documented].filter((r) => !live.has(r)).sort()).toEqual([]); // documented but not implemented
});

it("has resolvable $refs and secures every non-public operation", () => {
  const text = JSON.stringify(spec);
  for (const m of text.matchAll(/"\$ref":"#\/components\/(\w+)\/([\w-]+)"/g)) expect(spec.components[m[1]!][m[2]!], m[0]).toBeDefined();
  const publicOps = new Set(["/healthz", "/readyz", "/v1/auth/register", "/v1/auth/login", "/v1/auth/mfa/verify", "/v1/auth/refresh", "/v1/auth/logout", "/v1/payments/webhook"]);
  for (const [path, item] of Object.entries<any>(spec.paths)) for (const op of Object.values<any>(item)) {
    if (!publicOps.has(path)) expect(op.security?.length, `${path} must require auth`).toBeGreaterThan(0);
  }
});

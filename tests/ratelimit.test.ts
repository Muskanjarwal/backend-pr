import { afterAll, beforeAll, expect, it } from "vitest";
import { createEnv, type Env } from "./helpers.js";

let env: Env;
beforeAll(async () => { env = await createEnv({ RATE_LIMIT_AUTH_PER_MIN: "3", RATE_LIMIT_GLOBAL_PER_MIN: "20" }); });
afterAll(() => env.close());

it("throttles credential endpoints per client and sends rate-limit headers", async () => {
  const attempt = () => env.api("POST", "/v1/auth/login", { body: { email: "x@example.com", password: "whatever-password" } });
  const statuses: number[] = [];
  for (let i = 0; i < 5; i++) statuses.push((await attempt()).status);
  expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
  expect(statuses.slice(3)).toEqual([429, 429]);
  const limited = await attempt();
  expect(limited.body.error.code).toBe("RATE_LIMITED");
  expect(limited.headers["retry-after"]).toBeTruthy();
});

it("never rate-limits health probes", async () => {
  for (let i = 0; i < 40; i++) expect((await env.api("GET", "/healthz")).status).toBe(200);
  expect((await env.api("GET", "/readyz")).status).toBe(200);
});

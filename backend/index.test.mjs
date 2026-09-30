import { describe, expect, it } from "vitest";
import { handler, isHealthGet, resolvePath } from "./index.mjs";

function httpApiEvent({
  method = "GET",
  rawPath,
  routeKey,
  stage = "dev",
} = {}) {
  return {
    version: "2.0",
    routeKey: routeKey ?? `${method} ${rawPath?.replace(new RegExp(`^/${stage}`), "") || "/"}`,
    rawPath,
    requestContext: {
      stage,
      http: { method, path: rawPath },
    },
  };
}

describe("resolvePath", () => {
  it("strips a named stage prefix from rawPath", () => {
    expect(
      resolvePath({
        rawPath: "/dev/api/health",
        requestContext: { stage: "dev" },
      }),
    ).toBe("/api/health");
  });

  it("leaves $default paths unchanged", () => {
    expect(
      resolvePath({
        rawPath: "/api/health",
        requestContext: { stage: "$default" },
      }),
    ).toBe("/api/health");
  });

  it("leaves paths that do not start with the stage unchanged", () => {
    expect(
      resolvePath({
        rawPath: "/api/health",
        requestContext: { stage: "dev" },
      }),
    ).toBe("/api/health");
  });
});

describe("isHealthGet / handler", () => {
  it("returns 200 for named-stage rawPath via routeKey", async () => {
    const event = httpApiEvent({
      rawPath: "/dev/api/health",
      routeKey: "GET /api/health",
      stage: "dev",
    });
    expect(isHealthGet(event)).toBe(true);
    const res = await handler(event);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
  });

  it("returns 200 for staging and prod stage prefixes", async () => {
    for (const stage of ["staging", "prod"]) {
      const event = httpApiEvent({
        rawPath: `/${stage}/api/health`,
        routeKey: "GET /api/health",
        stage,
      });
      expect((await handler(event)).statusCode).toBe(200);
    }
  });

  it("returns 200 when routeKey is missing but stage-stripped path matches", async () => {
    const event = {
      rawPath: "/dev/api/health",
      requestContext: { stage: "dev", http: { method: "GET", path: "/dev/api/health" } },
    };
    expect((await handler(event)).statusCode).toBe(200);
  });

  it("returns 200 for $default /api/health", async () => {
    const event = httpApiEvent({
      rawPath: "/api/health",
      routeKey: "GET /api/health",
      stage: "$default",
    });
    expect((await handler(event)).statusCode).toBe(200);
  });

  it("returns 501 for other routes", async () => {
    const event = httpApiEvent({
      method: "GET",
      rawPath: "/dev/api/exercises",
      routeKey: "GET /api/{proxy+}",
      stage: "dev",
    });
    const res = await handler(event);
    expect(res.statusCode).toBe(501);
    expect(JSON.parse(res.body).path).toBe("/api/exercises");
  });
});

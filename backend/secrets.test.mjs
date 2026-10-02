import { describe, expect, it } from "vitest";
import { createSecretLoader, notionConfigured } from "./secrets.mjs";

describe("createSecretLoader", () => {
  it("uses direct env values and does not call SSM", async () => {
    let calls = 0;
    const load = createSecretLoader({
      getParameter: async () => {
        calls += 1;
        return "from-ssm";
      },
    });
    const secrets = await load({ NOTION_TOKEN: " secret_local ", NOTION_DATABASE_ID: " db-1 " });
    expect(secrets).toEqual({ token: "secret_local", databaseId: "db-1" });
    expect(calls).toBe(0);
  });

  it("reads each SecureString once until the TTL passes", async () => {
    let now = 0;
    const calls = [];
    const load = createSecretLoader({
      now: () => new Date(now),
      ttlMs: 1000,
      getParameter: async (name) => {
        calls.push(name);
        return name.endsWith("token") ? "secret_from_ssm" : "db-1";
      },
    });
    const env = {
      NOTION_TOKEN_PARAM: "/app/notion/token",
      NOTION_DATABASE_ID_PARAM: "/app/notion/database-id",
    };
    expect(await load(env)).toEqual({ token: "secret_from_ssm", databaseId: "db-1" });
    expect(await load(env)).toEqual({ token: "secret_from_ssm", databaseId: "db-1" });
    expect(calls).toEqual(["/app/notion/token", "/app/notion/database-id"]);

    now = 1000;
    await load(env);
    expect(calls).toHaveLength(4);
  });

  it("fails closed when the parameter value is empty", async () => {
    const load = createSecretLoader({
      getParameter: async () => "  ",
    });
    await expect(
      load({
        NOTION_TOKEN_PARAM: "/app/notion/token",
        NOTION_DATABASE_ID_PARAM: "/app/notion/database-id",
      }),
    ).rejects.toThrow("設定がありません");
  });
});

describe("notionConfigured", () => {
  it("is true when either direct values or parameter names exist", () => {
    expect(notionConfigured({})).toBe(false);
    expect(notionConfigured({ NOTION_TOKEN_PARAM: "/t", NOTION_DATABASE_ID_PARAM: "/d" })).toBe(true);
  });
});

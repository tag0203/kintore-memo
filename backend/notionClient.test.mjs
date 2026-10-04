import { describe, expect, it } from "vitest";
import { createNotionClient } from "./notionClient.mjs";

const env = { NOTION_TOKEN: "secret_token", NOTION_DATABASE_ID: "db-1" };

const schema = {
  properties: {
    名前: { type: "title" },
    種目: {
      type: "select",
      select: { options: [{ name: "スクワット" }, { name: "ラットプルダウン" }] },
    },
    "重量（kg）": { type: "number" },
    回数: { type: "number" },
    セット数: { type: "number" },
    きつさ: { type: "select" },
    日付: { type: "date" },
  },
};

const squatPage = {
  id: "page-1",
  created_time: "2026-09-25T12:10:00.000Z",
  properties: {
    名前: { title: [{ plain_text: "－" }] },
    種目: { select: { name: "スクワット" } },
    "重量（kg）": { number: 80 },
    回数: { number: 11 },
    セット数: { number: 3 },
    きつさ: { select: { name: "ややきつい" } },
    日付: { date: { start: "2026-09-25" } },
  },
};

function fakeFetch(record) {
  return async (input, init) => {
    if (record) {
      const headers = init?.headers ?? {};
      if (headers.Authorization) record.auth = headers.Authorization;
      if (String(input).endsWith("/pages")) record.createBody = init?.body ?? "";
    }
    let payload = {};
    const url = String(input);
    if (url.endsWith("/databases/db-1")) payload = { data_sources: [{ id: "ds-1" }] };
    else if (url.endsWith("/data_sources/ds-1") && init?.method !== "POST") payload = schema;
    else if (url.endsWith("/query")) payload = { results: [squatPage], has_more: false };
    else if (url.endsWith("/pages")) payload = squatPage;
    else throw new Error(`unexpected ${url}`);
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
}

describe("Notion client", () => {
  it("does not call the API when the token is missing", async () => {
    let called = false;
    const client = createNotionClient({}, () => {
      called = true;
      throw new Error("fetch should not run");
    });
    await expect(client.listExercises()).rejects.toThrow("NOTION_TOKEN が設定されていません");
    expect(called).toBe(false);
  });

  it("resolves the data source once, then reuses it", async () => {
    const calls = [];
    const inner = fakeFetch();
    const client = createNotionClient(env, async (input, init) => {
      calls.push(String(input));
      return inner(input, init);
    });
    await Promise.all([client.listExercises(), client.listExercises()]);
    expect(calls).toEqual([
      "https://api.notion.com/v1/databases/db-1",
      "https://api.notion.com/v1/data_sources/ds-1",
    ]);
    const window = await client.loadRecentWindow();
    expect(window.complete).toBe(true);
    expect(window.logs[0]).toMatchObject({ exercise: "スクワット", difficulty: 3 });
    expect(calls.at(-1)).toBe("https://api.notion.com/v1/data_sources/ds-1/query");
  });

  it("reads the previous row and posts one new page", async () => {
    const record = { auth: "", createBody: "" };
    const client = createNotionClient(env, fakeFetch(record));
    await expect(client.getPreviousLog("スクワット", "2026-09-26")).resolves.toMatchObject([
      {
        weightKg: 80,
        difficulty: 3,
        date: "2026-09-25",
      },
    ]);
    expect(record.auth).toBe("Bearer secret_token");

    await client.createLog({
      exercise: "スクワット",
      weightKg: 82.5,
      reps: 8,
      sets: 3,
      difficulty: 4,
      date: "2026-09-26",
    });
    expect(record.createBody).toContain("data_source_id");
    expect(record.createBody).toContain("82.5");
    expect(record.createBody).toContain("きつい");
    expect(record.createBody).not.toContain("secret_token");
  });
});

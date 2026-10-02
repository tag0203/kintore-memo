import { describe, expect, it } from "vitest";
import {
  NOTION_CACHE_PK,
  NOTION_CACHE_TTL_SECONDS,
  buildNotionCacheItem,
  createDynamoNotionCache,
  createMemoryNotionCache,
  createTieredNotionCache,
  notionCacheKey,
  readNotionCacheItem,
} from "./notionCache.mjs";

const at = new Date("2026-10-02T00:00:00.000Z");

function fakeDoc() {
  const items = new Map();
  return {
    items,
    async get(_table, key) {
      return items.get(`${key.pk}|${key.sk}`) ?? null;
    },
    async put(_table, item) {
      items.set(`${item.pk}|${item.sk}`, structuredClone(item));
    },
    async delete(_table, key) {
      items.delete(`${key.pk}|${key.sk}`);
    },
  };
}

describe("NotionCache item", () => {
  it("uses the shared partition, segment sort key, and 300s TTL", () => {
    const key = notionCacheKey(["logs", "previous", "スクワット", "2026-10-02"]);
    expect(key).toEqual({ pk: NOTION_CACHE_PK, sk: "logs#previous#スクワット#2026-10-02" });
    const item = buildNotionCacheItem({
      segments: ["exercises", "recent"],
      body: "{\"v\":[]}",
      now: at,
    });
    expect(item.ttl).toBe(Math.floor(at.getTime() / 1000) + NOTION_CACHE_TTL_SECONDS);
    expect(item.entityType).toBe("NotionCache");
    expect(readNotionCacheItem(item).body).toBe("{\"v\":[]}");
    expect(() => notionCacheKey(["bad#seg"])).toThrow(/cache segment/);
    expect(() => notionCacheKey(["a", "b", "c", "d", "e"])).toThrow(/cache key/);
  });
});

describe("cache stores", () => {
  it("expires memory entries and round-trips Dynamo items", async () => {
    let now = at;
    const memory = createMemoryNotionCache({ now: () => now });
    await memory.put(["exercises"], "{\"v\":1}", at);
    expect(await memory.get(["exercises"])).toBe("{\"v\":1}");
    now = new Date(at.getTime() + NOTION_CACHE_TTL_SECONDS * 1000);
    expect(await memory.get(["exercises"])).toBeNull();

    const doc = fakeDoc();
    const dynamo = createDynamoNotionCache({
      tableName: "kintore-memo-dev",
      client: doc,
      now: () => at,
    });
    await dynamo.put(["exercises", "recent"], "{\"v\":2}", at);
    expect(await dynamo.get(["exercises", "recent"])).toBe("{\"v\":2}");
    const stored = [...doc.items.values()][0];
    expect(stored.pk).toBe(NOTION_CACHE_PK);
    expect(stored.ttl).toBe(Math.floor(at.getTime() / 1000) + NOTION_CACHE_TTL_SECONDS);
  });

  it("keeps serving from memory when Dynamo fails", async () => {
    const memory = createMemoryNotionCache({ now: () => at });
    const dynamo = {
      async get() {
        throw new Error("missing table");
      },
      async put() {
        throw new Error("missing table");
      },
      async delete() {
        throw new Error("missing table");
      },
    };
    const cache = createTieredNotionCache(memory, dynamo);
    await cache.put(["exercises"], "{\"v\":1}", at);
    expect(await cache.get(["exercises"])).toBe("{\"v\":1}");
  });

  it("deletes a previous-log prefix from both tiers", async () => {
    const memory = createMemoryNotionCache({ now: () => at });
    const doc = fakeDoc();
    const dynamo = createDynamoNotionCache({ tableName: "t", client: doc, now: () => at });
    const cache = createTieredNotionCache(memory, dynamo);
    await cache.put(["logs", "previous", "スクワット", "2026-10-02"], "{\"v\":null}", at);
    await cache.put(["exercises"], "{\"v\":[]}", at);
    await cache.deleteWhere((key) => key.startsWith("logs#previous#スクワット#"));
    expect(await cache.get(["logs", "previous", "スクワット", "2026-10-02"])).toBeNull();
    expect(await cache.get(["exercises"])).toBe("{\"v\":[]}");
    expect(doc.items.size).toBe(1);
  });
});

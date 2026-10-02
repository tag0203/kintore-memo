/**
 * Optional short-TTL cache for Notion responses (not source of truth).
 *
 * Item shape comes from dynamodb.mjs (docs/dynamodb.md): pk=CACHE#notion,
 * 1–4 segments, 300s TTL, replace-in-place. DayPlan is not written here.
 *
 * Navigation must use the client cache (#12). This store only collapses
 * repeated bootstrap / refresh calls and warm Lambda containers.
 */
import {
  ItemValidationError,
  NOTION_CACHE_PK,
  NOTION_CACHE_TTL_SECONDS,
  SORT_KEY,
  buildNotionCacheItem,
  notionCacheKey,
  readNotionCacheItem,
} from "./dynamodb.mjs";

export {
  ItemValidationError,
  NOTION_CACHE_PK,
  NOTION_CACHE_TTL_SECONDS,
  buildNotionCacheItem,
  notionCacheKey,
  readNotionCacheItem,
};

function cacheKeyOf(segments) {
  return notionCacheKey(segments)[SORT_KEY];
}

/**
 * Process-local cache. Warm containers reuse it; cold starts do not.
 * @param {{ now?: () => Date }} [options]
 */
export function createMemoryNotionCache(options = {}) {
  const now = options.now ?? (() => new Date());
  /** @type {Map<string, { body: string, ttl: number }>} */
  const items = new Map();

  function live(segments) {
    const key = cacheKeyOf(segments);
    const entry = items.get(key);
    if (!entry) return null;
    if (entry.ttl <= Math.floor(now().getTime() / 1000)) {
      items.delete(key);
      return null;
    }
    return entry;
  }

  return {
    async get(segments) {
      return live(segments)?.body ?? null;
    },
    async put(segments, body, at = now()) {
      const item = buildNotionCacheItem({ segments, body, now: at });
      items.set(item.cacheKey, { body: item.body, ttl: item.ttl });
    },
    async delete(segments) {
      items.delete(cacheKeyOf(segments));
    },
    async deleteWhere(predicate) {
      for (const key of items.keys()) {
        if (predicate(key)) items.delete(key);
      }
    },
  };
}

/**
 * DynamoDB adapter. `client` is the document-level port tests can fake:
 * `{ get(key), put(item), delete(key) }` with plain JS objects (pk/sk/ttl).
 * @param {{ tableName: string, client: { get: Function, put: Function, delete: Function }, now?: () => Date }} options
 */
export function createDynamoNotionCache(options) {
  const now = options.now ?? (() => new Date());
  const tableName = options.tableName;
  if (!tableName) throw new Error("TABLE_NAME が設定されていません");

  return {
    async get(segments) {
      const key = notionCacheKey(segments);
      const item = await options.client.get(tableName, key);
      if (!item) return null;
      const record = readNotionCacheItem(item);
      if (record.ttl <= Math.floor(now().getTime() / 1000)) return null;
      return record.body;
    },
    async put(segments, body, at = now()) {
      const item = buildNotionCacheItem({ segments, body, now: at });
      await options.client.put(tableName, item);
    },
    async delete(segments) {
      await options.client.delete(tableName, notionCacheKey(segments));
    },
  };
}

/**
 * Memory first, then Dynamo. Dynamo errors are ignored: the cache is optional
 * and a failed Get/Put must not fail a Notion read.
 * Deletes still go to both. Dynamo cannot be scanned, so prefix deletes only
 * cover keys this process has seen, and fixed keys the caller deletes explicitly.
 * Leftovers expire after 300s.
 */
export function createTieredNotionCache(memory, dynamo) {
  /** @type {Set<string>} */
  const known = new Set();

  return {
    async get(segments) {
      const local = await memory.get(segments);
      if (local != null) return local;
      try {
        const remote = await dynamo.get(segments);
        if (remote != null) {
          known.add(cacheKeyOf(segments));
          try {
            await memory.put(segments, remote);
          } catch {
            // A too-large or invalid body still returns to the caller.
          }
        }
        return remote;
      } catch (error) {
        warnCache(error);
        return null;
      }
    },
    async put(segments, body, at) {
      await memory.put(segments, body, at);
      known.add(cacheKeyOf(segments));
      try {
        await dynamo.put(segments, body, at);
      } catch (error) {
        warnCache(error);
      }
    },
    async delete(segments) {
      known.delete(cacheKeyOf(segments));
      await memory.delete(segments);
      try {
        await dynamo.delete(segments);
      } catch (error) {
        warnCache(error);
      }
    },
    async deleteWhere(predicate) {
      const keys = [...known].filter(predicate);
      await memory.deleteWhere(predicate);
      for (const key of keys) {
        known.delete(key);
        try {
          await dynamo.delete(key.split("#"));
        } catch (error) {
          warnCache(error);
        }
      }
    },
  };
}

function warnCache(error) {
  const name = error instanceof Error ? error.name : "Error";
  console.warn(`[notion-cache] ${name}`);
}

/**
 * Dynamo when TABLE_NAME is set, unless NOTION_CACHE=memory.
 * SDK or table failures fall back to memory so a read still reaches Notion.
 * @param {Record<string, string | undefined>} env
 */
export async function createDefaultNotionCache(env) {
  const memory = createMemoryNotionCache();
  if (!env.TABLE_NAME || env.NOTION_CACHE === "memory") return memory;
  try {
    const dynamo = await createAwsDynamoNotionCache(env.TABLE_NAME);
    return createTieredNotionCache(memory, dynamo);
  } catch (error) {
    warnCache(error);
    return memory;
  }
}

/**
 * Low-level DynamoDB client behind the plain-object port.
 * Imported only when TABLE_NAME is set, so unit tests do not load the SDK.
 * @param {string} tableName
 */
export async function createAwsDynamoNotionCache(tableName) {
  const { DynamoDBClient, GetItemCommand, PutItemCommand, DeleteItemCommand } = await import(
    "@aws-sdk/client-dynamodb"
  );
  const { marshall, unmarshall } = await import("@aws-sdk/util-dynamodb");
  const client = new DynamoDBClient({});
  return createDynamoNotionCache({
    tableName,
    client: {
      async get(name, key) {
        const result = await client.send(
          new GetItemCommand({
            TableName: name,
            Key: marshall(key),
          }),
        );
        return result.Item ? unmarshall(result.Item) : null;
      },
      async put(name, item) {
        await client.send(
          new PutItemCommand({
            TableName: name,
            Item: marshall(item),
          }),
        );
      },
      async delete(name, key) {
        await client.send(
          new DeleteItemCommand({
            TableName: name,
            Key: marshall(key),
          }),
        );
      },
    },
  });
}

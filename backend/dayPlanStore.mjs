/**
 * DayPlan persistence. Production uses GetItem and PutItem on TABLE_NAME.
 * Tests pass createMemoryDayPlanStore() so nothing talks to AWS.
 */

/**
 * @returns {{
 *   get: (key: { pk: string, sk: string }) => Promise<unknown>,
 *   put: (item: Record<string, unknown>) => Promise<void>,
 * }}
 */
export function createMemoryDayPlanStore() {
  /** @type {Map<string, unknown>} */
  const items = new Map();
  const id = (key) => `${key.pk}\0${key.sk}`;
  return {
    async get(key) {
      const found = items.get(id(key));
      return found == null ? null : structuredClone(found);
    },
    async put(item) {
      items.set(id(item), structuredClone(item));
    },
  };
}

/**
 * Low-level DynamoDB client, same SDK as NotionCache.
 * Imported only when TABLE_NAME is set, so unit tests do not load the SDK.
 * @param {Record<string, string | undefined>} [env]
 */
export async function createDefaultDayPlanStore(env = process.env) {
  const tableName = env.TABLE_NAME;
  if (!tableName) throw new Error("TABLE_NAME is not set");
  const { DynamoDBClient, GetItemCommand, PutItemCommand } = await import("@aws-sdk/client-dynamodb");
  const { marshall, unmarshall } = await import("@aws-sdk/util-dynamodb");
  const client = new DynamoDBClient({});
  return {
    /**
     * @param {{ pk: string, sk: string }} key
     */
    async get(key) {
      const result = await client.send(
        new GetItemCommand({
          TableName: tableName,
          Key: marshall(key),
        }),
      );
      return result.Item ? unmarshall(result.Item) : null;
    },
    /**
     * @param {Record<string, unknown>} item
     */
    async put(item) {
      await client.send(
        new PutItemCommand({
          TableName: tableName,
          Item: marshall(item),
        }),
      );
    },
  };
}

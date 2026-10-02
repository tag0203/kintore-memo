/**
 * Notion token and database id.
 * Production reads SSM SecureString (WithDecryption) and keeps the values in memory.
 * Tests and `sam local` may set NOTION_TOKEN and NOTION_DATABASE_ID instead.
 * Neither value is returned to the client.
 */

const DEFAULT_TTL_MS = 5 * 60 * 1000;

/**
 * @param {{ getParameter: (name: string) => Promise<string>, now?: () => Date, ttlMs?: number }} deps
 */
export function createSecretLoader(deps) {
  const now = deps.now ?? (() => new Date());
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  /** @type {{ expiresAt: number, token: string, databaseId: string } | null} */
  let cached = null;

  return async function loadSecrets(env) {
    const directToken = env.NOTION_TOKEN?.trim();
    const directDatabaseId = env.NOTION_DATABASE_ID?.trim();
    if (directToken && directDatabaseId) {
      return { token: directToken, databaseId: directDatabaseId };
    }

    if (cached && now().getTime() < cached.expiresAt) {
      return { token: cached.token, databaseId: cached.databaseId };
    }

    const tokenName = env.NOTION_TOKEN_PARAM?.trim();
    const databaseName = env.NOTION_DATABASE_ID_PARAM?.trim();
    if (!tokenName || !databaseName) throw new Error("Notion の設定がありません");

    const [token, databaseId] = await Promise.all([
      deps.getParameter(tokenName),
      deps.getParameter(databaseName),
    ]);
    if (!token?.trim() || !databaseId?.trim()) throw new Error("Notion の設定がありません");

    cached = {
      expiresAt: now().getTime() + ttlMs,
      token: token.trim(),
      databaseId: databaseId.trim(),
    };
    return { token: cached.token, databaseId: cached.databaseId };
  };
}

/** Names are configured even when the SecureString value has not been created yet. */
export function notionConfigured(env) {
  return Boolean(
    (env.NOTION_TOKEN?.trim() && env.NOTION_DATABASE_ID?.trim()) ||
      (env.NOTION_TOKEN_PARAM?.trim() && env.NOTION_DATABASE_ID_PARAM?.trim()),
  );
}

let ssmClient;

async function getParameter(name) {
  const { SSMClient, GetParameterCommand } = await import("@aws-sdk/client-ssm");
  ssmClient ??= new SSMClient({});
  const result = await ssmClient.send(
    new GetParameterCommand({
      Name: name,
      WithDecryption: true,
    }),
  );
  return result.Parameter?.Value ?? "";
}

export function createDefaultSecretLoader() {
  return createSecretLoader({ getParameter });
}

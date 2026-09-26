/** Worker のバインディング。値は wrangler secret で渡し、リポジトリには置かない。 */
export interface NotionEnv {
  NOTION_TOKEN?: string;
  NOTION_DATABASE_ID?: string;
  /** 静的サイトと Worker のオリジンが違うときだけ。未設定なら CORS ヘッダを出さない。 */
  ALLOWED_ORIGIN?: string;
}

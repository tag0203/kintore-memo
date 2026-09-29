import { useState, type FormEvent } from "react";
import { useAuth } from "../auth/AuthContext";
import { CognitoAuthError } from "../auth/cognitoClient";

export function LoginScreen() {
  const auth = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const needsNewPassword = auth.pendingNewPasswordEmail != null;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (needsNewPassword) {
        if (newPassword !== confirmPassword) {
          setError("新しいパスワードが一致しません");
          return;
        }
        await auth.finishNewPassword(newPassword);
        return;
      }
      const result = await auth.signIn(email, password);
      if (result === "newPasswordRequired") {
        setPassword("");
        setNewPassword("");
        setConfirmPassword("");
      }
    } catch (caught) {
      if (caught instanceof CognitoAuthError) setError(caught.message);
      else if (caught instanceof Error) setError(caught.message);
      else setError("ログインに失敗しました");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app-shell">
      <section className="screen login-screen">
        <h1 className="today-title">筋トレメモ</h1>
        <p className="login-lead">
          {needsNewPassword
            ? "初回ログインです。新しいパスワードを設定してください。"
            : "メールアドレスとパスワードでログインします。"}
        </p>

        <form className="login-form" onSubmit={onSubmit}>
          {!needsNewPassword && (
            <>
              <label className="field-label" htmlFor="login-email">
                メールアドレス
              </label>
              <input
                id="login-email"
                className="text-input"
                type="email"
                autoComplete="username"
                inputMode="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />

              <label className="field-label" htmlFor="login-password">
                パスワード
              </label>
              <input
                id="login-password"
                className="text-input"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </>
          )}

          {needsNewPassword && (
            <>
              <p className="login-email-line">{auth.pendingNewPasswordEmail}</p>
              <label className="field-label" htmlFor="login-new-password">
                新しいパスワード
              </label>
              <input
                id="login-new-password"
                className="text-input"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
              />
              <p className="section-hint">8文字以上。大文字・小文字・数字を含めてください。</p>

              <label className="field-label" htmlFor="login-confirm-password">
                新しいパスワード（確認）
              </label>
              <input
                id="login-confirm-password"
                className="text-input"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
              />
            </>
          )}

          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}

          <div className="action-row single">
            <button type="submit" className="btn primary" disabled={busy}>
              {busy ? "送信中…" : needsNewPassword ? "パスワードを設定して入る" : "ログイン"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { completeNewPassword, refreshAuthTokens, signInWithPassword } from "./cognitoClient";
import { readCognitoConfig, type CognitoConfig } from "./config";
import { mayApplyRefreshedTokens } from "./sessionEpoch";
import { runBeforeSignOut } from "./signOutSequence";
import { clearStoredTokens, loadStoredTokens, saveStoredTokens } from "./tokenStore";
import { displayEmailFromIdToken, isIdTokenFresh, type AuthTokens } from "./tokens";

export type AuthStatus = "loading" | "unconfigured" | "signedOut" | "signedIn";

interface AuthContextValue {
  status: AuthStatus;
  /** Cognito 設定があるとき true。ローカルのモックのみ起動では false */
  required: boolean;
  config: CognitoConfig | null;
  email: string | null;
  signIn: (email: string, password: string) => Promise<"ok" | "newPasswordRequired">;
  finishNewPassword: (newPassword: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** トークンを消す前に待つ。戻り値で登録を外す。 */
  registerBeforeSignOut: (hook: () => Promise<void>) => () => void;
  /** API Gateway 用。期限切れなら refresh。未ログインなら throw */
  getIdToken: () => Promise<string>;
  pendingNewPasswordEmail: string | null;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const config = useMemo(() => readCognitoConfig(), []);
  const [status, setStatus] = useState<AuthStatus>(() => (config ? "loading" : "unconfigured"));
  const [tokens, setTokens] = useState<AuthTokens | null>(null);
  const [challenge, setChallenge] = useState<{ email: string; session: string } | null>(null);
  const beforeSignOutRef = useRef<Array<() => Promise<void>>>([]);
  const signingOutRef = useRef(false);
  /** Bumped when logout clears tokens, so a late refresh cannot restore them. */
  const sessionEpochRef = useRef(0);

  useEffect(() => {
    if (!config) {
      setStatus("unconfigured");
      return;
    }
    const stored = loadStoredTokens();
    if (!stored) {
      setStatus("signedOut");
      return;
    }
    setTokens(stored);
    setStatus("signedIn");
  }, [config]);

  const applyTokens = useCallback((next: AuthTokens) => {
    saveStoredTokens(next);
    setTokens(next);
    setChallenge(null);
    setStatus("signedIn");
  }, []);

  const signIn = useCallback(
    async (email: string, password: string) => {
      if (!config) throw new Error("Cognito が設定されていません");
      const result = await signInWithPassword(config, email, password);
      if (result.kind === "newPasswordRequired") {
        setChallenge({ email: result.email, session: result.session });
        return "newPasswordRequired" as const;
      }
      applyTokens(result.tokens);
      return "ok" as const;
    },
    [applyTokens, config],
  );

  const finishNewPassword = useCallback(
    async (newPassword: string) => {
      if (!config || !challenge) throw new Error("パスワード更新のセッションがありません");
      const next = await completeNewPassword(config, challenge.email, newPassword, challenge.session);
      applyTokens(next);
    },
    [applyTokens, challenge, config],
  );

  const registerBeforeSignOut = useCallback((hook: () => Promise<void>) => {
    beforeSignOutRef.current.push(hook);
    return () => {
      beforeSignOutRef.current = beforeSignOutRef.current.filter((item) => item !== hook);
    };
  }, []);

  const signOut = useCallback(async () => {
    if (signingOutRef.current) return;
    signingOutRef.current = true;
    try {
      await runBeforeSignOut(beforeSignOutRef.current);
    } finally {
      sessionEpochRef.current += 1;
      clearStoredTokens();
      setTokens(null);
      setChallenge(null);
      setStatus(config ? "signedOut" : "unconfigured");
      signingOutRef.current = false;
    }
  }, [config]);

  const getIdToken = useCallback(async () => {
    if (!config) throw new Error("Cognito が設定されていません");
    if (!tokens) throw new Error("ログインしていません");
    if (isIdTokenFresh(tokens)) return tokens.idToken;
    const epoch = sessionEpochRef.current;
    try {
      const next = await refreshAuthTokens(config, tokens.refreshToken);
      if (!mayApplyRefreshedTokens(epoch, sessionEpochRef.current)) return next.idToken;
      applyTokens(next);
      return next.idToken;
    } catch (error) {
      if (!mayApplyRefreshedTokens(epoch, sessionEpochRef.current)) {
        throw error instanceof Error ? error : new Error("ログアウトしました");
      }
      signOut();
      throw new Error("セッションの有効期限が切れました。再度ログインしてください");
    }
  }, [applyTokens, config, signOut, tokens]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      required: config != null,
      config,
      email: tokens ? displayEmailFromIdToken(tokens.idToken) : null,
      signIn,
      finishNewPassword,
      signOut,
      registerBeforeSignOut,
      getIdToken,
      pendingNewPasswordEmail: challenge?.email ?? null,
    }),
    [challenge?.email, config, finishNewPassword, getIdToken, registerBeforeSignOut, signIn, signOut, status, tokens],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("AuthProvider がありません");
  return value;
}

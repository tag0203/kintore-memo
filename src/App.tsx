import { useEffect, useMemo, useRef, useState } from "react";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { ClientProvider } from "./clientContext";
import { createHttpDayPlanClient } from "./data/dayPlanClient";
import { selectWorkoutClient } from "./data/selectClient";
import { PickerScreen } from "./screens/PickerScreen";
import { RecordScreen } from "./screens/RecordScreen";
import { LoginScreen } from "./screens/LoginScreen";
import { TodayScreen } from "./screens/TodayScreen";
import { parseHash, routeToHash, type Route } from "./route";
import { SessionProvider, useSession } from "./session";

function useRoute() {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));

  useEffect(() => {
    if (!window.location.hash) window.history.replaceState(null, "", "#/");
    const sync = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  const navigate = (next: Route) => {
    const hash = routeToHash(next);
    if (window.location.hash === hash) {
      setRoute(next);
      return;
    }
    window.location.hash = hash;
  };

  const back = () => {
    if (window.history.length > 1) {
      window.history.back();
      return;
    }
    navigate({ screen: "today" });
  };

  return { route, navigate, back };
}

function Shell() {
  const { route, navigate, back } = useRoute();
  const session = useSession();

  useEffect(() => {
    if (route.screen === "picker") document.title = "種目を追加 · 筋トレメモ";
    else if (route.screen === "record") document.title = `${route.exercise} · 筋トレメモ`;
    else document.title = "今日のトレーニング · 筋トレメモ";
  }, [route]);

  return (
    <div className="app-shell">
      {session.saveError && (
        <p className="save-error" role="alert">
          {session.saveError}
        </p>
      )}
      {route.screen === "today" && <TodayScreen navigate={navigate} />}
      {route.screen === "picker" && <PickerScreen navigate={navigate} back={back} />}
      {route.screen === "record" && (
        <RecordScreen key={route.exercise} exercise={route.exercise} navigate={navigate} back={back} />
      )}
    </div>
  );
}

function AppBody() {
  const auth = useAuth();
  const getIdTokenRef = useRef(auth.getIdToken);
  getIdTokenRef.current = auth.getIdToken;
  const client = useMemo(
    () =>
      selectWorkoutClient({
        apiBaseUrl: auth.config?.apiBaseUrl ?? null,
        signedIn: auth.status === "signedIn",
        getIdToken: () => getIdTokenRef.current(),
      }),
    [auth.config?.apiBaseUrl, auth.status],
  );
  const dayPlan = useMemo(() => {
    const base = auth.config?.apiBaseUrl?.trim() ?? "";
    if (auth.status !== "signedIn" || !base) return null;
    return createHttpDayPlanClient({
      apiBaseUrl: base,
      getIdToken: () => getIdTokenRef.current(),
    });
  }, [auth.config?.apiBaseUrl, auth.status]);

  if (auth.status === "loading") {
    return (
      <div className="app-shell">
        <section className="screen">
          <p className="status-line">読み込み中…</p>
        </section>
      </div>
    );
  }

  if (auth.required && auth.status !== "signedIn") {
    return <LoginScreen />;
  }

  return (
    <ClientProvider client={client}>
      <SessionProvider dayPlan={dayPlan}>
        <Shell />
      </SessionProvider>
    </ClientProvider>
  );
}

export function App() {
  return (
    <AuthProvider>
      <AppBody />
    </AuthProvider>
  );
}

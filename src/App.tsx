import { useEffect, useMemo, useState } from "react";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { ClientProvider } from "./clientContext";
import { createBrowserClient } from "./data/browserClient";
import { PickerScreen } from "./screens/PickerScreen";
import { RecordScreen } from "./screens/RecordScreen";
import { LoginScreen } from "./screens/LoginScreen";
import { TodayScreen } from "./screens/TodayScreen";
import { parseHash, routeToHash, type Route } from "./route";
import { SessionProvider } from "./session";

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

  useEffect(() => {
    if (route.screen === "picker") document.title = "種目を追加 · 筋トレメモ";
    else if (route.screen === "record") document.title = `${route.exercise} · 筋トレメモ`;
    else document.title = "今日のトレーニング · 筋トレメモ";
  }, [route]);

  return (
    <div className="app-shell">
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
  const client = useMemo(() => createBrowserClient(), []);

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

  // WorkoutLogClient の本番 HTTP 差し替えは #12。いまはモックのまま。
  return (
    <ClientProvider client={client}>
      <SessionProvider>
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

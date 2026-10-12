export type Route =
  | { screen: "today" }
  | { screen: "picker" }
  | { screen: "record"; exercise: string; draftId?: string };

export function parseHash(hash: string): Route {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const url = new URL(raw || "/", "http://kintore.local");
  if (url.pathname === "/exercises") return { screen: "picker" };
  if (url.pathname === "/record") {
    const exercise = url.searchParams.get("exercise")?.trim() ?? "";
    const draftId = url.searchParams.get("draft")?.trim() ?? "";
    if (exercise) return { screen: "record", exercise, ...(draftId ? { draftId } : {}) };
  }
  return { screen: "today" };
}

export function routeToHash(route: Route): string {
  if (route.screen === "picker") return "#/exercises";
  if (route.screen === "record") {
    const params = new URLSearchParams();
    params.set("exercise", route.exercise);
    if (route.draftId) params.set("draft", route.draftId);
    return `#/record?${params.toString()}`;
  }
  return "#/";
}

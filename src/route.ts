export type Route =
  | { screen: "today" }
  | { screen: "picker" }
  | { screen: "record"; exercise: string };

export function parseHash(hash: string): Route {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const url = new URL(raw || "/", "http://kintore.local");
  if (url.pathname === "/exercises") return { screen: "picker" };
  if (url.pathname === "/record") {
    const exercise = url.searchParams.get("exercise")?.trim() ?? "";
    if (exercise) return { screen: "record", exercise };
  }
  return { screen: "today" };
}

export function routeToHash(route: Route): string {
  if (route.screen === "picker") return "#/exercises";
  if (route.screen === "record") {
    return `#/record?exercise=${encodeURIComponent(route.exercise)}`;
  }
  return "#/";
}

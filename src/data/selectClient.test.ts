import { describe, expect, it, vi } from "vitest";
import { selectWorkoutClient } from "./selectClient";

describe("selectWorkoutClient", () => {
  it("keeps the in-memory client when Cognito is signed in but the API URL is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const workout = selectWorkoutClient({
        apiBaseUrl: null,
        signedIn: true,
        getIdToken: async () => "id-token",
        now: new Date(2026, 8, 26),
      });
      const exercises = await workout.listExercises();
      expect(exercises.map((exercise) => exercise.name)).toContain("スクワット");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses the HTTP client only after sign-in when the API URL is set", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () =>
      Response.json({
        date: "2026-10-02",
        exercises: [{ name: "デッドリフト", lastPickedAt: null }],
        recent: [],
        logs: { デッドリフト: { previous: [], today: [] } },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const signedOut = selectWorkoutClient({
        apiBaseUrl: "https://api.example/dev",
        signedIn: false,
        getIdToken: async () => "id-token",
        now: new Date(2026, 9, 2),
      });
      await signedOut.listExercises();
      expect(fetchMock).not.toHaveBeenCalled();

      const signedIn = selectWorkoutClient({
        apiBaseUrl: "https://api.example/dev",
        signedIn: true,
        getIdToken: async () => "id-token",
        now: new Date(2026, 9, 2),
      });
      await signedIn.getPreviousLog("デッドリフト", "2026-10-02");
      expect(fetchMock).toHaveBeenCalledOnce();
      const init = fetchMock.mock.calls[0][1];
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer id-token");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

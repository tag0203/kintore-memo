import { describe, expect, it, vi } from "vitest";
import { apiUrl, authorizedFetch } from "./authorizedFetch";

describe("authorizedFetch", () => {
  it("sets Bearer IdToken on Authorization", async () => {
    let seenAuth: string | null = null;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenAuth = new Headers(init?.headers).get("Authorization");
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await authorizedFetch("/api/health", { method: "GET" }, async () => "id-token-value");
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(seenAuth).toBe("Bearer id-token-value");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("joins api base and path", () => {
    expect(apiUrl("https://api.example/dev/", "/api/exercises")).toBe(
      "https://api.example/dev/api/exercises",
    );
  });
});

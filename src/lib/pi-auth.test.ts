import { describe, expect, it } from "vitest";
import { getQuotaAuthSource } from "./pi-auth.js";

describe("getQuotaAuthSource", () => {
  it("uses the current ModelRegistry when AuthStorage is not exposed", () => {
    const modelRegistry = { getApiKeyForProvider: async (_provider: string) => "token" };

    expect(getQuotaAuthSource(modelRegistry)).toBe(modelRegistry);
  });

  it("uses legacy AuthStorage when the registry exposes it", () => {
    const authStorage = { getApiKey: async (_provider: string) => "token" };

    expect(getQuotaAuthSource({ authStorage })).toBe(authStorage);
  });
});

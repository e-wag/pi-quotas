import { describe, it, expect } from "vitest";
import { resolveQuotaProvider, isSupportedProvider } from "./quotas.js";
import type { ProviderPrefixMap } from "../config.js";

const prefixes: ProviderPrefixMap = {
  "acme-copilot/": "github-copilot",
  "acme-codex/": "openai-codex",
  "acme-openrouter/": "openrouter",
};

describe("resolveQuotaProvider", () => {
  it("returns the provider directly when it is supported", () => {
    expect(resolveQuotaProvider("anthropic", "claude-opus-4", {})).toBe("anthropic");
    expect(resolveQuotaProvider("github-copilot", "claude", prefixes)).toBe("github-copilot");
  });

  it("routes by longest matching prefix", () => {
    expect(resolveQuotaProvider("acme-proxy", "acme-copilot/claude-sonnet", prefixes)).toBe(
      "github-copilot",
    );
    expect(resolveQuotaProvider("acme-proxy", "acme-codex/gpt-5", prefixes)).toBe("openai-codex");
    expect(resolveQuotaProvider("acme-proxy", "acme-openrouter/deepseek", prefixes)).toBe("openrouter");
  });

  it("returns undefined when nothing matches", () => {
    expect(resolveQuotaProvider("acme-proxy", "unknown/model", prefixes)).toBeUndefined();
    expect(resolveQuotaProvider("acme-proxy", undefined, prefixes)).toBeUndefined();
    expect(resolveQuotaProvider(undefined, undefined, prefixes)).toBeUndefined();
  });

  it("handles empty prefix map", () => {
    expect(resolveQuotaProvider("acme-proxy", "acme-copilot/x", {})).toBeUndefined();
  });

  it("resolves to a value that isSupportedProvider accepts", () => {
    const resolved = resolveQuotaProvider("acme-proxy", "acme-copilot/claude", prefixes);
    expect(isSupportedProvider(resolved)).toBe(true);
  });

  it("picks the longest matching prefix", () => {
    const mixed: ProviderPrefixMap = {
      "a/": "openai-codex",
      "a/b/": "github-copilot",
    };
    expect(resolveQuotaProvider("proxy", "a/b/model", mixed)).toBe("github-copilot");
    expect(resolveQuotaProvider("proxy", "a/c/model", mixed)).toBe("openai-codex");
  });
});

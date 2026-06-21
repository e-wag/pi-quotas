import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AuthStorage } from "@mariozechner/pi-coding-agent";
import type { QuotasResult, SupportedQuotaProvider } from "../types/quotas.js";
import { configLoader, copilotHostsFromPrefixes } from "../config.js";
import {
  parseAnthropicUsage,
  parseCodexUsage,
  parseGitHubCopilotUsage,
  parseOpenRouterUsage,
  parseSyntheticUsage,
} from "./providers.js";

const execFileAsync = promisify(execFile);
const FETCH_TIMEOUT_MS = 15_000;
const MAX_BUFFER = 1024 * 1024;
const COPILOT_VERSION = "0.35.0";
const EDITOR_VERSION = "vscode/1.107.0";
const DEFAULT_GITHUB_HOST = "github.com";

type CopilotTarget = { host: string };

function normalizeHost(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    if (trimmed.includes("://")) return new URL(trimmed).hostname.toLowerCase();
    return new URL(`https://${trimmed}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function configuredCopilotTargets(): CopilotTarget[] | undefined {
  const raw = process.env.PI_QUOTAS_COPILOT_HOSTS;
  if (!raw) return undefined;

  const seen = new Set<string>();
  const targets: CopilotTarget[] = [];
  for (const value of raw.split(",")) {
    const host = normalizeHost(value);
    if (!host || seen.has(host)) continue;
    seen.add(host);
    targets.push({ host });
  }
  return targets;
}

function copilotTargetFromAuthStorage(authStorage: AuthStorage): CopilotTarget {
  const credential = authStorage.get("github-copilot") as any;
  const host = typeof credential?.enterpriseUrl === "string"
    ? normalizeHost(credential.enterpriseUrl)
    : undefined;
  return { host: host ?? DEFAULT_GITHUB_HOST };
}

/**
 * Build the full set of Copilot hosts to fetch when no explicit env override
 * (`PI_QUOTAS_COPILOT_HOSTS`) is set. Unions hosts configured in `quotas.json`
 * `providerPrefixes` (e.g. copilot-personal/ -> github.com,
 * copilot-enterprise/ -> ghe.host) with the legacy auth.json enterpriseUrl
 * default, so multi-host setups fetch every subscription the active model
 * might target. `filterWindowsForHost` narrows to the active model's host
 * afterward.
 */
function copilotTargetsForAllHosts(authStorage: AuthStorage): CopilotTarget[] {
  const seen = new Set<string>();
  const targets: CopilotTarget[] = [];
  const add = (host: string | undefined): void => {
    if (!host || seen.has(host)) return;
    seen.add(host);
    targets.push({ host });
  };
  for (const host of copilotHostsFromPrefixes(configLoader.getConfig().providerPrefixes)) add(host);
  add(copilotTargetFromAuthStorage(authStorage).host);
  if (targets.length === 0) add(DEFAULT_GITHUB_HOST);
  return targets;
}

async function fetchCopilotUsageForTarget(target: CopilotTarget, signal?: AbortSignal): Promise<QuotasResult> {
  try {
    const result = await execFileAsync(
      "gh",
      ["api", "--hostname", target.host, "/copilot_internal/user"],
      { signal, timeout: FETCH_TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: "utf8" },
    );
    const data = JSON.parse(result.stdout);
    return copilotSuccess(data, target.host);
  } catch (err: unknown) {
    if (err instanceof SyntaxError) {
      return failure("GitHub Copilot quota response was invalid JSON", "http");
    }
    if (err instanceof Error && err.name === "AbortError") {
      return failure("Request cancelled", "cancelled");
    }
    if (isCopilotCliTimeout(err)) {
      return failure(`GitHub Copilot quota request timed out for ${target.host}`, "timeout");
    }
    const anyErr = err as { code?: unknown; stderr?: unknown; message?: unknown };
    if (anyErr?.code === "ENOENT") return failure("GitHub CLI not found", "config");
    const detail = typeof anyErr?.stderr === "string" && anyErr.stderr.trim().length > 0
      ? anyErr.stderr.trim()
      : typeof anyErr?.message === "string" && anyErr.message.trim().length > 0
        ? anyErr.message.trim()
        : `Host ${target.host}`;
    return failure(`GitHub Copilot quota request failed for ${target.host}: ${detail}`, "http");
  }
}

function isTimeoutReason(reason: unknown): boolean {
  return (
    (reason instanceof DOMException && reason.name === "TimeoutError") ||
    (reason instanceof Error && reason.name === "TimeoutError")
  );
}

function isCopilotCliTimeout(err: unknown): boolean {
  const anyErr = err as { code?: unknown; killed?: unknown; message?: unknown };
  return (
    anyErr?.code === "ETIMEDOUT" ||
    anyErr?.killed === true ||
    (typeof anyErr?.message === "string" && anyErr.message.toLowerCase().includes("timed out"))
  );
}

function hasLimitedCopilotQuotaSnapshot(snap: any): boolean {
  const entitlement = Number(snap?.entitlement ?? 0);
  return Number.isFinite(entitlement) && entitlement > 0 && !snap?.unlimited;
}

function hasVisibleFreeTierCopilotWindows(snapshots: any): boolean {
  return ["chat", "completions"].some((key) => hasLimitedCopilotQuotaSnapshot(snapshots?.[key]));
}

function isFreeCopilotSku(value: unknown): boolean {
  return typeof value === "string" && /^free(?:_|$)/.test(value);
}

function copilotSuccess(data: any, host = DEFAULT_GITHUB_HOST): QuotasResult {
  return success(
    "github-copilot",
    parseGitHubCopilotUsage(data, host),
    copilotNoPremiumQuotaNote(data, host),
  );
}

function aggregateCopilotErrors(
  results: Array<{ host: string; result: QuotasResult }>,
): QuotasResult {
  if (results.length === 0) return failure("No GitHub Copilot hosts found", "config");

  const failures = results.filter(
    (entry): entry is { host: string; result: Extract<QuotasResult, { success: false }> } => !entry.result.success,
  );
  if (failures.length === 0) return failure("GitHub Copilot quota request failed", "http");

  const kinds: Array<Extract<QuotasResult, { success: false }>['error']['kind']> = [
    "cancelled",
    "timeout",
    "config",
    "network",
    "http",
  ];
  const kind = kinds.find((candidate) => failures.some((entry) => entry.result.error.kind === candidate)) ?? "http";
  const message = failures
    .map((entry) => `${entry.host}: ${entry.result.error.message}`)
    .filter((value, index, all) => all.indexOf(value) === index)
    .join("; ");
  return failure(message, kind);
}

async function providerAccessToken(
  authStorage: AuthStorage,
  provider: string,
): Promise<string | undefined> {
  return authStorage.getApiKey(provider);
}

function codexAccountId(authStorage: AuthStorage): string | undefined {
  const credential = authStorage.get("openai-codex") as any;
  if (typeof credential?.accountId === "string") return credential.accountId;
  try {
    const authPath = join(homedir(), ".codex", "auth.json");
    const data = JSON.parse(readFileSync(authPath, "utf8")) as any;
    return data?.tokens?.account_id ?? data?.tokens?.accountId;
  } catch {
    return undefined;
  }
}

type FetchJsonResult =
  | { ok: true; data: any }
  | {
      ok: false;
      status?: number;
      message: string;
      kind: "timeout" | "cancelled" | "http" | "network";
    };

async function fetchJson(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<FetchJsonResult> {
  const signals: AbortSignal[] = [AbortSignal.timeout(FETCH_TIMEOUT_MS)];
  if (signal) signals.push(signal);
  const combined = AbortSignal.any(signals);

  try {
    const response = await fetch(url, { ...init, signal: combined });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return {
        ok: false,
        status: response.status,
        message: body || response.statusText || `HTTP ${response.status}`,
        kind: "http",
      };
    }
    return { ok: true, data: await response.json() };
  } catch (err: unknown) {
    const isAbort =
      combined.aborted ||
      (err instanceof DOMException && err.name === "AbortError");
    if (isAbort) {
      if (isTimeoutReason(combined.reason)) {
        return { ok: false, message: "Request timed out", kind: "timeout" };
      }
      return { ok: false, message: "Request cancelled", kind: "cancelled" };
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return { ok: false, message, kind: "network" };
  }
}

function success(
  provider: SupportedQuotaProvider,
  windows: ReturnType<typeof parseAnthropicUsage>,
  note?: string,
): QuotasResult {
  return { success: true, data: { provider, windows, note } };
}

function copilotNoPremiumQuotaNote(data: any, host = DEFAULT_GITHUB_HOST): string | undefined {
  const snapshots = data?.quota_snapshots;
  const premium = snapshots?.premium_interactions;
  if (!premium) return undefined;

  if (hasLimitedCopilotQuotaSnapshot(premium)) return undefined;
  if (hasVisibleFreeTierCopilotWindows(snapshots)) return undefined;
  if (premium.has_quota !== false && !isFreeCopilotSku(data?.access_type_sku)) return undefined;

  const login = typeof data?.login === "string" && data.login.length > 0 ? data.login : undefined;
  const sku = typeof data?.access_type_sku === "string" && data.access_type_sku.length > 0
    ? data.access_type_sku
    : undefined;
  const hostSuffix = host === DEFAULT_GITHUB_HOST ? "" : ` on ${host}`;
  const account = login ? ` for ${login}` : "";
  const skuSuffix = sku ? ` (${sku})` : "";
  return `Free Copilot tier${account}${hostSuffix}${skuSuffix}: no premium quota`;
}

function failure(message: string, kind: "cancelled" | "timeout" | "config" | "http" | "network"): QuotasResult {
  return { success: false, error: { message, kind } };
}

export async function fetchAnthropicQuotasWithToken(
  accessToken: string | undefined,
  signal?: AbortSignal,
): Promise<QuotasResult> {
  if (!accessToken) return failure("No Anthropic OAuth token found", "config");
  const result = await fetchJson(
    "https://api.anthropic.com/api/oauth/usage",
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        Accept: "application/json",
      },
    },
    signal,
  );
  if (!result.ok) return failure(result.message, result.kind);
  return success("anthropic", parseAnthropicUsage(result.data));
}

export async function fetchCodexQuotasWithToken(
  accessToken: string | undefined,
  accountId: string | undefined,
  signal?: AbortSignal,
): Promise<QuotasResult> {
  if (!accessToken) return failure("No Codex access token found", "config");
  if (!accountId) return failure("No Codex account id found", "config");
  const result = await fetchJson(
    "https://chatgpt.com/backend-api/wham/usage",
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "ChatGPT-Account-Id": accountId,
        Accept: "application/json",
        Origin: "https://chatgpt.com",
        Referer: "https://chatgpt.com/",
        "User-Agent": "Mozilla/5.0",
      },
    },
    signal,
  );
  if (!result.ok) return failure(result.message, result.kind);
  return success("openai-codex", parseCodexUsage(result.data));
}

function copilotHeaders(authHeader: string): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: authHeader,
    "User-Agent": `GitHubCopilotChat/${COPILOT_VERSION}`,
    "Editor-Version": EDITOR_VERSION,
    "Editor-Plugin-Version": `copilot-chat/${COPILOT_VERSION}`,
    "Copilot-Integration-Id": "vscode-chat",
    "Content-Type": "application/json",
  };
}

/**
 * Try to get a token from `gh auth token` CLI as fallback when the Pi-stored
 * OAuth token is stale or the token exchange returns 401.
 */
function ghCliToken(): string | undefined {
  try {
    return execFileSync("gh", ["auth", "token"], {
      timeout: 5000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

async function tryGitHubUserEndpoint(
  authHeader: string,
  signal?: AbortSignal,
): Promise<FetchJsonResult> {
  return fetchJson(
    "https://api.github.com/copilot_internal/user",
    { headers: copilotHeaders(authHeader) },
    signal,
  );
}

function githubOAuthToken(authStorage: AuthStorage): string | undefined {
  // Pi's GitHub Copilot OAuth credential stores the GitHub OAuth token in
  // `refresh`; `access` is a Copilot proxy token (tid=...;proxy-ep=...) that
  // is valid for model calls but rejected by api.github.com quota endpoints.
  const credential = authStorage.get("github-copilot") as any;
  if (credential?.type !== "oauth") return undefined;
  return typeof credential.refresh === "string" && credential.refresh.length > 0
    ? credential.refresh
    : undefined;
}

async function fetchGitHubCopilotQuotasWithGitHubToken(
  githubToken: string | undefined,
  signal?: AbortSignal,
): Promise<QuotasResult> {
  if (!githubToken) return failure("No GitHub Copilot OAuth token found", "config");

  const bearerUsage = await tryGitHubUserEndpoint(`Bearer ${githubToken}`, signal);
  if (bearerUsage.ok) return copilotSuccess(bearerUsage.data);

  const tokenUsage = await tryGitHubUserEndpoint(`token ${githubToken}`, signal);
  if (tokenUsage.ok) return copilotSuccess(tokenUsage.data);

  return failure(tokenUsage.message, tokenUsage.kind);
}

export async function fetchGitHubCopilotQuotasWithToken(
  accessToken: string | undefined,
  signal?: AbortSignal,
): Promise<QuotasResult> {
  if (!accessToken) return failure("No GitHub Copilot OAuth token found", "config");

  // 1) Try Copilot token exchange with stored Pi token.
  const exchange = await fetchJson(
    "https://api.github.com/copilot_internal/v2/token",
    { headers: copilotHeaders(`Bearer ${accessToken}`) },
    signal,
  );

  if (exchange.ok && exchange.data?.token) {
    const usage = await tryGitHubUserEndpoint(`Bearer ${exchange.data.token}`, signal);
    if (usage.ok) return copilotSuccess(usage.data);
  }

  // 2) Try stored token directly.
  const directUsage = await tryGitHubUserEndpoint(`token ${accessToken}`, signal);
  if (directUsage.ok) return copilotSuccess(directUsage.data);

  // 3) Fallback: gh CLI token.
  const cliToken = ghCliToken();
  if (cliToken && cliToken !== accessToken) {
    const cliUsage = await tryGitHubUserEndpoint(`token ${cliToken}`, signal);
    if (cliUsage.ok) return copilotSuccess(cliUsage.data);
    return failure(cliUsage.message, cliUsage.kind);
  }

  return failure(directUsage.message, directUsage.kind);
}

export async function fetchAnthropicQuotas(
  authStorage: AuthStorage,
  signal?: AbortSignal,
): Promise<QuotasResult> {
  return fetchAnthropicQuotasWithToken(await providerAccessToken(authStorage, "anthropic"), signal);
}

export async function fetchCodexQuotas(
  authStorage: AuthStorage,
  signal?: AbortSignal,
): Promise<QuotasResult> {
  return fetchCodexQuotasWithToken(
    await providerAccessToken(authStorage, "openai-codex"),
    codexAccountId(authStorage),
    signal,
  );
}

export async function fetchGitHubCopilotQuotas(
  authStorage: AuthStorage,
  signal?: AbortSignal,
): Promise<QuotasResult> {
  const targets = configuredCopilotTargets() ?? copilotTargetsForAllHosts(authStorage);
  const results = await Promise.all(
    targets.map(async (target) => ({ host: target.host, result: await fetchCopilotUsageForTarget(target, signal) })),
  );
  const successes = results.filter(
    (entry): entry is { host: string; result: Extract<QuotasResult, { success: true }> } => entry.result.success,
  );

  if (successes.length > 0) {
    const windows = successes.flatMap((entry) => entry.result.data.windows);
    const note = windows.length === 0
      ? successes
        .map((entry) => entry.result.data.note)
        .filter((value): value is string => !!value)
        .filter((value, index, all) => all.indexOf(value) === index)
        .join("; ") || undefined
      : undefined;
    return success("github-copilot", windows, note);
  }

  return aggregateCopilotErrors(results);
}

export async function fetchOpenRouterQuotasWithToken(
  accessToken: string | undefined,
  signal?: AbortSignal,
): Promise<QuotasResult> {
  if (!accessToken) return failure("No OpenRouter API key found", "config");
  const result = await fetchJson(
    "https://openrouter.ai/api/v1/key",
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    },
    signal,
  );
  if (!result.ok) return failure(result.message, result.kind);
  return success("openrouter", parseOpenRouterUsage(result.data));
}

export async function fetchOpenRouterQuotas(
  authStorage: AuthStorage,
  signal?: AbortSignal,
): Promise<QuotasResult> {
  return fetchOpenRouterQuotasWithToken(
    await providerAccessToken(authStorage, "openrouter"),
    signal,
  );
}

export async function fetchSyntheticQuotas(
  _authStorage: AuthStorage,
  signal?: AbortSignal,
): Promise<QuotasResult> {
  const apiKey = process.env.SYNTHETIC_API_KEY;
  if (!apiKey) return failure("No Synthetic API key found (set SYNTHETIC_API_KEY)", "config");

  const result = await fetchJson(
    "https://api.synthetic.new/v2/quotas",
    {
      headers: { Authorization: `Bearer ${apiKey}` },
    },
    signal,
  );
  if (!result.ok) return failure(result.message, result.kind);
  return success("synthetic", parseSyntheticUsage(result.data));
}

export const PROVIDER_FETCHERS = {
  anthropic: fetchAnthropicQuotas,
  "openai-codex": fetchCodexQuotas,
  "github-copilot": fetchGitHubCopilotQuotas,
  openrouter: fetchOpenRouterQuotas,
  synthetic: fetchSyntheticQuotas,
} as const;

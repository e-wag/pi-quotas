export type SupportedQuotaProvider =
  | "anthropic"
  | "openai-codex"
  | "github-copilot"
  | "openrouter"
  | "synthetic";

export type QuotasErrorKind =
  | "cancelled"
  | "timeout"
  | "config"
  | "http"
  | "network";

export type QuotasResult =
  | { success: true; data: { windows: QuotaWindow[]; provider: SupportedQuotaProvider; note?: string } }
  | { success: false; error: { message: string; kind: QuotasErrorKind } };

export interface QuotaWindow {
  provider: SupportedQuotaProvider;
  /** Host this window was fetched from. Set for github-copilot multi-host quotas. */
  host?: string;
  label: string;
  usedPercent: number;
  resetsAt: Date;
  windowSeconds: number;
  usedValue: number;
  limitValue: number;
  isCurrency?: boolean;
  showPace?: boolean;
  paceScale?: number;
  limited?: boolean;
  nextAmount?: string;
  nextLabel?: string;
}

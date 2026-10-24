type ProviderApiKeyLookup = (
  provider: string,
) => string | undefined | Promise<string | undefined>;

export interface QuotaAuthSource {
  get?: (provider: string) => unknown;
  getApiKey?: ProviderApiKeyLookup;
  getApiKeyForProvider?: ProviderApiKeyLookup;
}

export type QuotaModelRegistry = QuotaAuthSource & {
  authStorage?: QuotaAuthSource;
};

/**
 * Pi 1.x resolves keys on ModelRegistry; older releases expose AuthStorage.
 */
export function getQuotaAuthSource(
  modelRegistry: QuotaModelRegistry | undefined,
): QuotaAuthSource | undefined {
  return modelRegistry?.authStorage ?? modelRegistry;
}

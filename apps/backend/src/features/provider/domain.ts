export interface ProviderDefinition {
  id: string;
  name: string;
  apiKeyEnv: string;
  baseUrlEnv?: string;
}

export interface StoredProviderConfig {
  apiKey?: string;
  baseUrl?: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  apiKeyEnv: string;
  configured: boolean;
}

/** A provider key the user added by name: for a provider declared in
 *  $OMA_HOME/models.yml, whose apiKeyEnv is not one of the builtins. */
export interface CustomKeyInfo {
  name: string;
  configured: boolean;
}

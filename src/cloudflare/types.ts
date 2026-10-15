export interface DurableStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  getAlarm(): Promise<number | null>;
  deleteAlarm(): Promise<void>;
  transaction<T>(callback: (transaction: DurableStorage) => Promise<T>): Promise<T>;
}

export interface DurableObjectStateLike {
  storage: DurableStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

export interface RunnerWorkerEnv {
  FETCH?: typeof fetch;
  BUILD_SHA?: string;
  RUNNER_API_KEYS: string;
  /** Registry used only by the dedicated production Worker; never overwrites base principals. */
  RUNNER_API_KEYS_PRODUCTION?: string;
  /** Additive principals provisioned independently from the protected base registry. */
  RUNNER_API_KEYS_ADDITIONAL?: string;
  /** Isolated principal registry for the dedicated sandbox3 Worker. */
  RUNNER_API_KEYS_SANDBOX3?: string;
  /** Separate sandbox developer principals; ignored by production authentication. */
  RUNNER_API_KEYS_DEVELOPER?: string;
  /** HMAC secret for short-lived Control Plane profile capabilities. */
  AGENT_API_PROFILE_DELEGATION_SECRET?: string;
  VM_WORKER_URL: string;
  VM_WORKER_TOKEN: string;
  /** Optional GHA/Azure route; used only after a confirmed pre-admission capacity refusal in France. */
  GHA_WORKER_URL?: string;
  GHA_WORKER_TOKEN?: string;
  RUNNER_API_PUBLIC_URL: string;
  RUN_LAUNCH_ENCRYPTION_KEY: string;
  RUNNER_ENGINE?: string;
  MOCK_TEST_ENABLED?: string;
  /** Comma-separated test-only profiles whose terminal Durable Object state may be reset. */
  SANDBOX_CLEANUP_PROFILES?: string;
  ALLOWED_REPOSITORIES: string;
  ALLOWED_ENVIRONMENT_NAMES?: string;
  LLM_LADDER_TOKEN?: string;
  OPENAI_API_KEY?: string;
  /** Optional server-provisioned BYOK connection metadata; contains no secret values. */
  RUNNER_MODEL_CONNECTIONS?: string;
  /** Explicit sandbox-only gates; production stays on the existing CP path. */
  RUNNER_DEVELOPER_API_ENABLED?: string;
  RUNNER_BYOK_ENABLED?: string;
  RUNNER_WEBHOOKS_ENABLED?: string;
  /** Reviewed endpoint metadata; signing secrets live in separate Worker secret bindings. */
  RUNNER_WEBHOOKS?: string;
  /** Optional pinned OpenCode model identifier for managed developer runs. */
  RUNNER_DEVELOPER_MANAGED_MODEL?: string;
  /** Signing key for 24-hour guest artifact download capabilities. */
  RUNNER_GUEST_DOWNLOAD_SECRET?: string;
  MCP_TEST_AUTH_TOKEN?: string;
  MCP_TEST_RUNNER_PRIVATE_JWK?: string;
  MCP_TEST_CATALOGUE_VERSION?: string;
  MCP_TEST_EXPIRES_AT?: string;
  /** Sandbox-only service grant to the authenticated MCP Host user catalog. */
  MCP_USER_AUTH_TOKEN?: string;
  MCP_USER_RUNNER_PRIVATE_JWK?: string;
  MCP_USER_PROFILE_USER_IDS?: string;
  MCP_USER_CATALOGUE_VERSION?: string;
  MCP_USER_CATALOGUE_DIGEST?: string;
  [binding: string]: unknown;
  RUNNER_RUNS: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } };
}

export interface ApiPrincipal {
  keyHash: string;
  principalId: string;
  profileId: string;
  /** Trusted repository binding for this profile principal; request bodies cannot override it. */
  repository?: string;
  tenantId?: string;
  scopes: string[];
  engines?: string[];
  mcpBindings?: string[];
  /** Explicit opt-in for the simplified developer API. Existing CP keys remain unchanged. */
  developerApi?: boolean;
  /** Explicitly provisioned accountless developer key. */
  developerGuest?: boolean;
}

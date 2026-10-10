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
  /** Additive principals provisioned independently from the protected base registry. */
  RUNNER_API_KEYS_ADDITIONAL?: string;
  /** HMAC secret for short-lived Control Plane profile capabilities. */
  AGENT_API_PROFILE_DELEGATION_SECRET?: string;
  VM_WORKER_URL: string;
  VM_WORKER_TOKEN: string;
  RUNNER_API_PUBLIC_URL: string;
  RUN_LAUNCH_ENCRYPTION_KEY: string;
  RUNNER_ENGINE?: string;
  MOCK_TEST_ENABLED?: string;
  ALLOWED_REPOSITORIES: string;
  ALLOWED_ENVIRONMENT_NAMES?: string;
  LLM_LADDER_TOKEN?: string;
  OPENAI_API_KEY?: string;
  MCP_TEST_AUTH_TOKEN?: string;
  MCP_TEST_RUNNER_PRIVATE_JWK?: string;
  MCP_TEST_CATALOGUE_VERSION?: string;
  MCP_TEST_EXPIRES_AT?: string;
  /** Read-only credential bound to one Telegram UX sandbox principal/profile/repository. */
  TELEGRAM_UX_REPOSITORY_READ_TOKEN?: string;
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
}

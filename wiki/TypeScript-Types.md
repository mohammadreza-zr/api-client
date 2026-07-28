# TypeScript Types

The complete public type surface. Everything here is importable.

```ts
import type { IRes, ApiClient, ClientOptions /* … */ } from "@mrzr/api-client";
```

---

## Primitives

```ts
type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type AuthMode = "header" | "cookie";
type StorageKind = "memory" | "local" | "session" | "cookie";
```

---

## `IRes<R>` — the response envelope

```ts
interface IRes<R = unknown> {
  statusCode: number;
  status: boolean;
  message: string;
  data?: R;
  loading: boolean;
  errors?: Record<string, string[]>;
  error?: unknown;
  headers?: Record<string, string>;
  canceled?: boolean;
  cancelReason?: string;
}
```

`data` is optional because a 204, an empty body, or a parse failure legitimately yields no payload. Narrow it with `status`:

```ts
const res = await api.get<User[]>("/users", { throwError: false });
if (res.status) {
  res.data!.map(u => u.name);   // non-null assertion is safe here
}
```

Or a type guard that makes `data` required:

```ts
function ok<R>(res: IRes<R>): res is IRes<R> & { data: R } {
  return res.status && res.data !== undefined;
}

if (ok(res)) res.data.map(u => u.name); // no assertion needed
```

---

## `ApiError`

```ts
class ApiError extends Error {
  readonly name: "ApiError";
  readonly statusCode: number;
  readonly errors?: Record<string, string[]>;
  readonly data?: unknown;
  readonly response: IRes<unknown>;
  readonly canceled: boolean;
  readonly cancelReason?: string;
}
```

Typing the field-error map for a specific form:

```ts
interface SignupErrors {
  email?: string[];
  password?: string[];
}

function signupErrors(e: unknown): SignupErrors {
  return e instanceof ApiError ? ((e.errors ?? {}) as SignupErrors) : {};
}
```

---

## `RequestConfig<T>`

```ts
interface RequestConfig<T = unknown>
  extends Omit<RequestInit, "body" | "method" | "headers" | "credentials"> {
  headers?: Record<string, string>;
  addToUrl?: (string | number)[];
  addTemplateToUrl?: Record<string, string | number>;
  params?: Params<T>;
  baseUrl?: string;
  timeout?: number;
  fullData?: boolean;
  refreshTokenCheck?: boolean;
  skipAuth?: boolean;
  stringifyBody?: boolean;
  isFormData?: boolean;
  hideErrorMessage?: boolean;
  throwError?: boolean;
  uploadSkewMs?: number;
  duplex?: "half";
  log?: boolean;
  cancelable?: boolean;
  cancelKey?: string;
  cancelGroup?: string | string[];
  takeLatest?: boolean;
  throwOnCancel?: boolean;
  beforeFunc?: (body: unknown) => unknown;
  afterFunc?: (data: T) => unknown;
  beforeSelectOptions?: (data: T) => unknown;
}
```

Extending `RequestInit` is what makes `cache`, `mode`, `redirect`, `signal`, `keepalive` and friends available with correct types.

The `T` parameter types the *transform hooks* and `params.ordering`. Usually it is inferred from the method's `R`:

```ts
await api.get<User[]>("/users", {
  afterFunc: (data) => data.filter(u => u.active), // data: User[]
});
```

---

## Cancellation types

```ts
interface CancelOptions {
  methods?: HttpMethod[] | "all";   // default ["GET"]
  throwOnCancel?: boolean;          // default: follows throwError
  takeLatest?: boolean;             // default false
}

interface PendingRequest {
  id: number;
  method: HttpMethod;
  url: string;      // fully resolved, query included
  path: string;     // no origin, no query — what patterns match
  key?: string;
  groups: string[];
  startedAt: number;
}

interface CancelMatch {
  url?: string | RegExp;
  method?: HttpMethod | HttpMethod[];
  key?: string;
  group?: string;
}

type CancelSelector =
  | string
  | RegExp
  | CancelMatch
  | ((request: PendingRequest) => boolean);

interface CancelScope {
  readonly name: string;
  get<R = unknown>(url: string, config?: RequestConfig<R>): Promise<IRes<R>>;
  post<R = unknown>(url: string, body?: unknown, config?: RequestConfig<R>): Promise<IRes<R>>;
  put<R = unknown>(url: string, body?: unknown, config?: RequestConfig<R>): Promise<IRes<R>>;
  patch<R = unknown>(url: string, body?: unknown, config?: RequestConfig<R>): Promise<IRes<R>>;
  delete<R = unknown>(url: string, config?: RequestConfig<R>): Promise<IRes<R>>;
  cancel(reason?: string): number;
  pending(): PendingRequest[];
}
```

A predicate selector gets full type inference:

```ts
api.cancel((r) => r.method === "GET" && r.startedAt < Date.now() - 5_000);
```

See **[[Cancellation]]**.

---

## `Params<T>` and `Ordering<T>`

```ts
type Ordering<T = unknown> = { [K in keyof T]?: "asc" | "desc" };

interface Params<T = unknown> {
  ordering?: T extends ListResponse<infer R> ? Ordering<R> : Ordering<T>;
  [key: string]: unknown;
}
```

`ordering` unwraps `ListResponse<T>` automatically, so you order by the *item* fields:

```ts
await api.get<ListResponse<User>>("/users", {
  params: { ordering: { createdAt: "desc" } }, // keys are User's, not ListResponse's
});
```

The index signature keeps arbitrary params allowed.

---

## `ListResponse<T>`

```ts
interface ListResponse<T = unknown> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}
```

The DRF-style pagination shape, provided for convenience:

```ts
const { data } = await api.get<ListResponse<User>>("/users", { params: { page: 2 } });
data?.results;  // User[]
data?.count;    // number
```

---

## Auth types

```ts
interface AuthState {
  isAuthenticated: boolean;
  expiresAt: number | null;
  user?: unknown;
}

interface TokenPair {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;   // epoch ms; derived from the JWT `exp` when omitted
}

type TokenExtractor = (body: unknown) => TokenPair | null;
```

`user` is `unknown` because it is whatever your server returns. Narrow it in your own layer:

```ts
interface AppUser { id: number; email: string; role: "admin" | "member" }

export const currentUser = (s: AuthState) => s.user as AppUser | undefined;
```

Or wrap the whole state:

```ts
type TypedAuthState = Omit<AuthState, "user"> & { user?: AppUser };

api.onAuthStateChange((s) => setState(s as TypedAuthState));
```

---

## `TokenStorage`

```ts
interface TokenStorage {
  get(): Promise<TokenPair | null> | TokenPair | null;
  set(tokens: TokenPair): Promise<void> | void;
  clear(): Promise<void> | void;
}
```

Sync or async — the client awaits everything. See [[Storage Adapters]].

---

## `LogEntry`

```ts
interface LogEntry {
  url: string;
  method: HttpMethod;
  statusCode: number;
  status: boolean;
  message: string;
  durationMs: number;
  timestamp: string;
  error?: unknown;
}
```

---

## `ClientOptions`

```ts
interface ClientOptions {
  baseUrl?: string;
  timeout?: number;
  throwError?: boolean;

  xsrfCookieName?: string;
  xsrfHeaderName?: string;
  getCsrfToken?: () => string | undefined;

  headers?: Record<string, string>;
  authMode?: AuthMode;
  credentials?: RequestCredentials;

  cancel?: boolean | CancelOptions;

  worker?: boolean;
  multiTab?: boolean;

  storage?: StorageKind | TokenStorage;
  storageKey?: string;

  loginUrl?: string;
  refreshUrl?: string;
  logoutUrl?: string;
  refreshSkewMs?: number;

  extractTokens?: TokenExtractor;
  buildRefreshBody?: (refreshToken?: string) => unknown;

  onAuthStateChanged?: (state: AuthState) => void;
  onAuthFailure?: () => void;
  onError?: (error: IRes<unknown>) => void;
  onLog?: (entry: LogEntry) => void;
}
```

See [[Client Options]] for defaults and behaviour.

---

## `ApiClient`

```ts
interface ApiClient {
  get<R = unknown>(url: string, config?: RequestConfig<R>): Promise<IRes<R>>;
  post<R = unknown>(url: string, body?: unknown, config?: RequestConfig<R>): Promise<IRes<R>>;
  put<R = unknown>(url: string, body?: unknown, config?: RequestConfig<R>): Promise<IRes<R>>;
  patch<R = unknown>(url: string, body?: unknown, config?: RequestConfig<R>): Promise<IRes<R>>;
  delete<R = unknown>(url: string, config?: RequestConfig<R>): Promise<IRes<R>>;

  login<R = unknown>(body: unknown, config?: RequestConfig<R>): Promise<IRes<R>>;
  logout<R = unknown>(config?: RequestConfig<R>): Promise<IRes<R>>;
  setTokens(tokens: TokenPair): Promise<void>;
  refresh(): Promise<string | null>;
  getAuthState(): Promise<AuthState>;
  onAuthStateChange(listener: (state: AuthState) => void): () => void;

  cancel(selector?: CancelSelector, reason?: string): number;
  pending(selector?: CancelSelector): PendingRequest[];
  cancelScope(name?: string): CancelScope;

  readonly isWorker: boolean;
  destroy(): void;
}
```

---

## Patterns

### A typed API layer

```ts
// api/users.ts
import { api } from "@/lib/api";
import type { ListResponse } from "@mrzr/api-client";

export interface User { id: number; name: string; email: string }
export interface CreateUser { name: string; email: string }

export const users = {
  list: (page = 1) =>
    api.get<ListResponse<User>>("/users", { params: { page } }).then(r => r.data!),

  byId: (id: number) =>
    api.get<User>("/users/{id}", { addTemplateToUrl: { id } }).then(r => r.data!),

  create: (input: CreateUser) =>
    api.post<User>("/users", input).then(r => r.data!),

  update: (id: number, patch: Partial<CreateUser>) =>
    api.patch<User>("/users/{id}", patch, { addTemplateToUrl: { id } }).then(r => r.data!),

  remove: (id: number) =>
    api.delete<void>("/users/{id}", { addTemplateToUrl: { id } }),
};
```

`.then(r => r.data!)` is safe here because `throwError` is on: a failure rejects before the `then`.

### Deriving types from a route map

```ts
interface Routes {
  "/users": { GET: User[]; POST: User };
  "/users/{id}": { GET: User; PATCH: User; DELETE: void };
}

function typedGet<P extends keyof Routes>(
  path: P,
  config?: RequestConfig<Routes[P] extends { GET: infer R } ? R : never>,
) {
  return api.get<Routes[P] extends { GET: infer R } ? R : never>(path as string, config);
}

const users = await typedGet("/users"); // IRes<User[]>
```

### Narrowing an unknown error

```ts
function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

function isStatus(e: unknown, code: number): e is ApiError {
  return isApiError(e) && e.statusCode === code;
}

if (isStatus(err, 409)) showConflictDialog(err.message);
```

Next: **[[Framework Recipes]]**

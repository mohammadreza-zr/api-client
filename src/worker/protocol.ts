// ── Main Thread → Worker ─────────────────────────────────

export type WorkerRequest =
  | SetupMessage
  | FetchMessage
  | AuthCallMessage
  | CancelMessage
  | PingMessage;

export interface SetupMessage {
  type: "SETUP";
  payload: {
    baseUrl: string;
    timeout: number;
    authMode: "header" | "cookie";
    credentials: RequestCredentials;
    defaultHeaders: Record<string, string>;
    refreshUrl: string;
    // For body-provider mode: initial tokens (sent once, then forgotten)
    initialAccessToken?: string;
    initialRefreshToken?: string;
  };
}

export interface FetchMessage {
  type: "FETCH";
  id: string; // unique request ID for correlation
  payload: {
    method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
    url: string;
    body?: unknown;
    headers?: Record<string, string>;
    params?: Record<string, unknown>;
    addTemplateToUrl?: Record<string, string | number>;
    addToUrl?: (string | number)[];
    stringifyBody?: boolean;
    isFormData?: boolean;
    fullData?: boolean;
    refreshTokenCheck?: boolean;
    throwError?: boolean;
    log?: boolean;
  };
}

export interface AuthCallMessage {
  type: "AUTH_CALL";
  payload:
    | { action: "login"; body: Record<string, unknown>; url?: string }
    | { action: "logout"; url?: string }
    | { action: "setTokens"; accessToken: string; refreshToken: string; expiresAt?: number };
}

export interface CancelMessage {
  type: "CANCEL";
  id: string;
}

export interface PingMessage {
  type: "PING";
}

// ── Worker → Main Thread ─────────────────────────────────

export type WorkerResponse =
  | FetchResultMessage
  | AuthStateChangedMessage
  | AuthResultMessage
  | ErrorMessage
  | PongMessage
  | ReadyMessage;

export interface FetchResultMessage {
  type: "FETCH_RESULT";
  id: string;
  payload: {
    statusCode: number;
    status: boolean;
    message: string;
    data?: unknown;
    errors?: Record<string, string[]>;
  };
}

export interface AuthStateChangedMessage {
  type: "AUTH_STATE_CHANGED";
  payload: {
    isAuthenticated: boolean;
    expiresAt: number | null;
    user?: unknown;
    // NEVER includes tokens
  };
}

export interface AuthResultMessage {
  type: "AUTH_RESULT";
  payload: {
    success: boolean;
    message: string;
    user?: unknown;
    expiresAt?: number;
    // NEVER includes tokens
  };
}

export interface ErrorMessage {
  type: "ERROR";
  id?: string;
  payload: {
    message: string;
    code?: string;
  };
}

export interface PongMessage {
  type: "PONG";
}

export interface ReadyMessage {
  type: "READY";
}

// ── Multi-Tab Broadcast ──────────────────────────────────

export type TabBroadcast =
  | { type: "REFRESH_STARTED"; tabId: string }
  | { type: "REFRESH_COMPLETED"; tabId: string; expiresAt: number; isAuthenticated: boolean }
  | { type: "LOGOUT"; tabId: string }
  | { type: "AUTH_STATE_SYNC"; tabId: string; isAuthenticated: boolean; expiresAt: number | null };
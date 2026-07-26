/** Standardized API response wrapper. */
export interface IRes<R = unknown> {
  statusCode: number;
  status: boolean;
  message: string;
  data?: R;
  loading: boolean;
  errors?: Record<string, string[]>;
  error?: unknown;
}

/** Generic list response from the server. */
export interface ListResponse<T = unknown> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

/** Ordering helper for list endpoints. */
export type Ordering<T = unknown> = {
  [K in keyof T]?: "asc" | "desc";
};
/**
 * Thin fetch wrapper. Originally a skeleton for a backend that didn't exist —
 * the real backend now exists for /rag and /documents (see features/ragSearch),
 * though /conversations etc. below are still unbuilt on the server side.
 */

import { logger } from "./logger";

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "/api";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function isAuthError(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.status === 403);
}

/** TODO: read from the auth feature once sign-in exists. */
export async function getToken(): Promise<string> {
  return localStorage.getItem("drig.token") ?? "";
}

export async function authHeaders(): Promise<HeadersInit> {
  const token = await getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function apiUrl(path: string): string {
  return `${BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = init.method ?? "GET";
  const url = apiUrl(path);
  const start = performance.now();

  logger.info(`-> ${method} ${url}`);

  try {
    // A multipart body must NOT get a Content-Type: the browser sets it with
    // the boundary, and forcing application/json here would break the upload.
    const isMultipart = init.body instanceof FormData;

    const res = await fetch(url, {
      ...init,
      headers: {
        ...(isMultipart ? {} : { "Content-Type": "application/json" }),
        ...(await authHeaders()),
        ...init.headers,
      },
    });

    const ms = Math.round(performance.now() - start);

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        code?: string;
        message?: string;
      };
      const err = new ApiError(res.status, body.code ?? "unknown", body.message ?? res.statusText);
      logger.timing(`<- ${method} ${url} FAILED (${res.status})`, ms);
      throw err;
    }

    logger.timing(`<- ${method} ${url} OK (${res.status})`, ms);

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const ms = Math.round(performance.now() - start);
    logger.error(`${method} ${url} network error after ${ms}ms`, err);
    throw err;
  }
}

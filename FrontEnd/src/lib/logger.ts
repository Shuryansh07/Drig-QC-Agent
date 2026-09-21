/**
 * Frontend counterpart to BackEnd/src/utils/logger.js — same shape
 * (timestamp + level + message) so browser console output reads consistently
 * with the backend's terminal/logs/app.log output when debugging a request
 * end to end.
 */

const timestamp = () => new Date().toISOString();

export const logger = {
  info: (message: string, ...rest: unknown[]) => {
    console.log(`${timestamp()} [INFO] ${message}`, ...rest);
  },
  warn: (message: string, ...rest: unknown[]) => {
    console.warn(`${timestamp()} [WARN] ${message}`, ...rest);
  },
  error: (message: string, err?: unknown) => {
    console.error(`${timestamp()} [ERROR] ${message}`, err ?? "");
  },
  timing: (label: string, ms: number) => {
    console.log(`${timestamp()} [TIMING] ${label}: ${ms}ms`);
  },
};

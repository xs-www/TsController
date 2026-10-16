/**
 * 极简结构化日志。
 *
 * 本工具是常驻本地进程，日志直接写 stderr，格式保持单行可 grep。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, detail?: Record<string, unknown>): void;
  info(message: string, detail?: Record<string, unknown>): void;
  warn(message: string, detail?: Record<string, unknown>): void;
  error(message: string, detail?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

function emit(scope: string, level: LogLevel, message: string, detail?: Record<string, unknown>): void {
  const line: Record<string, unknown> = {
    t: new Date().toISOString(),
    level,
    scope,
    msg: message,
  };
  if (detail && Object.keys(detail).length > 0) line.detail = detail;
  const text = JSON.stringify(line);
  if (level === 'error' || level === 'warn') process.stderr.write(text + '\n');
  else process.stdout.write(text + '\n');
}

/** 创建根 logger；`minLevel` 以下的日志被丢弃。 */
export function createLogger(minLevel: LogLevel = 'info', scope = 'app'): Logger {
  const threshold = ORDER[minLevel];
  const make = (sc: string): Logger => ({
    debug: (m, d) => ORDER.debug >= threshold && emit(sc, 'debug', m, d),
    info: (m, d) => ORDER.info >= threshold && emit(sc, 'info', m, d),
    warn: (m, d) => ORDER.warn >= threshold && emit(sc, 'warn', m, d),
    error: (m, d) => ORDER.error >= threshold && emit(sc, 'error', m, d),
    child: (sub) => make(`${sc}:${sub}`),
  });
  return make(scope);
}

/** 测试与非 CLI 场景使用的静默 logger。 */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

// Tagged console logger so the multisig-tester output is easy to grep in DevTools.
//
// Usage:
//   const log = logger('App');
//   log.info('clicked sync');
//   log.error('sync failed', err);

const STYLE_BY_LEVEL: Record<Level, string> = {
  debug: 'color:#888',
  info: 'color:#7dd3fc',
  warn: 'color:#facc15',
  error: 'color:#f87171',
};

type Level = 'debug' | 'info' | 'warn' | 'error';

function ts(): string {
  const d = new Date();
  return `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function emit(level: Level, scope: string, args: unknown[]): void {
  const fn = console[level] ?? console.log;
  fn(`%c[${ts()}][${scope}]`, STYLE_BY_LEVEL[level], ...args);
}

export function logger(scope: string) {
  return {
    debug: (...args: unknown[]) => emit('debug', scope, args),
    info: (...args: unknown[]) => emit('info', scope, args),
    warn: (...args: unknown[]) => emit('warn', scope, args),
    error: (...args: unknown[]) => emit('error', scope, args),
  };
}

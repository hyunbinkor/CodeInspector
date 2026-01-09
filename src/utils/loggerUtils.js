/**
 * 로거 유틸리티
 * 
 * @module utils/loggerUtils
 */

const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m'
};

const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4
};

const LEVEL_CONFIG = {
  error: { color: COLORS.red, label: 'ERROR' },
  warn: { color: COLORS.yellow, label: 'WARN ' },
  info: { color: COLORS.blue, label: 'INFO ' },
  debug: { color: COLORS.magenta, label: 'DEBUG' },
  trace: { color: COLORS.cyan, label: 'TRACE' }
};

class Logger {
  constructor() {
    const envLevel = process.env.LOG_LEVEL?.toLowerCase();
    const defaultLevel = process.env.NODE_ENV === 'production' ? 'info' : 'debug';
    
    this.currentLevel = LOG_LEVELS[envLevel] !== undefined ? envLevel : defaultLevel;
    this.currentLevelValue = LOG_LEVELS[this.currentLevel];
    this.useColors = process.env.NO_COLOR !== '1' && process.stdout.isTTY;
  }

  getTimestamp() {
    const now = new Date();
    const pad = (num) => String(num).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
           `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  }

  shouldLog(level) {
    return LOG_LEVELS[level] <= this.currentLevelValue;
  }

  formatValue(value) {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'object') {
      try {
        return JSON.stringify(value, null, 2);
      } catch {
        return '[Object]';
      }
    }
    return String(value);
  }

  log(level, ...args) {
    if (!this.shouldLog(level)) return;

    const config = LEVEL_CONFIG[level];
    const timestamp = this.getTimestamp();
    const messageContent = args.map(arg => this.formatValue(arg)).join(' ');

    const timestampStr = this.useColors ? `${COLORS.gray}${timestamp}${COLORS.reset}` : timestamp;
    const levelStr = this.useColors ? `${config.color}[${config.label}]${COLORS.reset}` : `[${config.label}]`;

    const finalMessage = `${timestampStr} ${levelStr} ${messageContent}`;

    if (level === 'error' || level === 'warn') {
      console.error(finalMessage);
    } else {
      console.log(finalMessage);
    }
  }

  error(...args) { this.log('error', ...args); }
  warn(...args) { this.log('warn', ...args); }
  info(...args) { this.log('info', ...args); }
  debug(...args) { this.log('debug', ...args); }
  trace(...args) { this.log('trace', ...args); }

  setLevel(level) {
    if (LOG_LEVELS[level] !== undefined) {
      this.currentLevel = level;
      this.currentLevelValue = LOG_LEVELS[level];
    }
  }
}

const logger = new Logger();

export default logger;
export { Logger, LOG_LEVELS };

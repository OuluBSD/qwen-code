/**
 * Fine-grained timestamp logger for qwen server/client debugging
 *
 * Format: [YYYY-MM-DD HH:MM:SS.milliseconds] [PID:12345] [LEVEL] [tag:id] message
 *
 * This allows merging and sorting logs from both TypeScript server and C++
 * client to understand the exact sequence of events.
 *
 * Usage:
 *   const logger = new QwenLogger("qwen-server", "tcp-session-123");
 *   logger.info("Client connected from", clientAddress);
 *   logger.debug("Received message:", JSON.stringify(msg));
 *
 * Environment variables:
 *   QWEN_LOG_FILE - Path to log file (default: stderr)
 *   QWEN_LOG_LEVEL - Minimum log level: DEBUG, INFO, WARN, ERROR (default: INFO)
 */

import * as fs from 'fs';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3
}

export class QwenLogger {
  private tag: string;
  private id: string;
  private pid: number;
  private useFile: boolean = false;
  private logFilePath?: string;
  private minLevel: LogLevel = LogLevel.INFO;

  constructor(tag: string, id: string = "") {
    this.tag = tag;
    this.id = id;
    this.pid = process.pid;

    // Check environment for log file
    if (process.env['QWEN_LOG_FILE']) {
      this.logFilePath = process.env['QWEN_LOG_FILE'];
      this.useFile = true;
    }

    // Check environment for log level
    if (process.env['QWEN_LOG_LEVEL']) {
      const levelStr = process.env['QWEN_LOG_LEVEL'].toUpperCase();
      switch (levelStr) {
        case "DEBUG": this.minLevel = LogLevel.DEBUG; break;
        case "INFO": this.minLevel = LogLevel.INFO; break;
        case "WARN": this.minLevel = LogLevel.WARN; break;
        case "ERROR": this.minLevel = LogLevel.ERROR; break;
      }
    }
  }

  /**
   * Update the ID (e.g., when session ID becomes available)
   */
  setId(id: string): void {
    this.id = id;
  }

  debug(...args: any[]): void {
    this.logWithLevel(LogLevel.DEBUG, ...args);
  }

  info(...args: any[]): void {
    this.logWithLevel(LogLevel.INFO, ...args);
  }

  warn(...args: any[]): void {
    this.logWithLevel(LogLevel.WARN, ...args);
  }

  error(...args: any[]): void {
    this.logWithLevel(LogLevel.ERROR, ...args);
  }

  /**
   * Log with default INFO level
   */
  log(...args: any[]): void {
    this.logWithLevel(LogLevel.INFO, ...args);
  }

  private levelToString(level: LogLevel): string {
    switch (level) {
      case LogLevel.DEBUG: return "DEBUG";
      case LogLevel.INFO:  return "INFO ";
      case LogLevel.WARN:  return "WARN ";
      case LogLevel.ERROR: return "ERROR";
      default: return "?????";
    }
  }

  private getTimestamp(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const millis = String(now.getMilliseconds()).padStart(6, '0'); // Pad to 6 for microseconds format

    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${millis}`;
  }

  private logWithLevel(level: LogLevel, ...args: any[]): void {
    if (level < this.minLevel) return;

    // [timestamp] [PID:12345] [LEVEL] [tag:id] message
    let logLine = `[${this.getTimestamp()}] `;
    logLine += `[PID:${this.pid}] `;
    logLine += `[${this.levelToString(level)}] `;
    logLine += `[${this.tag}`;
    if (this.id) {
      logLine += `:${this.id}`;
    }
    logLine += `] `;

    // Append all arguments
    logLine += args.map(arg => {
      if (typeof arg === 'object') {
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      }
      return String(arg);
    }).join(' ');

    logLine += '\n';

    if (this.useFile && this.logFilePath) {
      // Append to file
      try {
        fs.appendFileSync(this.logFilePath, logLine);
      } catch (err) {
        // Fallback to stderr if file write fails
        process.stderr.write(logLine);
      }
    } else {
      // Write to stderr
      process.stderr.write(logLine);
    }
  }
}

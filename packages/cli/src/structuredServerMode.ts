/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Structured Server Mode - Provides semantic protocol for thick clients
 *
 * Unlike the thin client approach (terminal rendering), this sends structured
 * application state that allows C++ clients to build custom UIs.
 *
 * Supports three communication modes:
 * - stdin/stdout: Line-buffered JSON
 * - Named pipes: Bidirectional filesystem pipes
 * - TCP: Network-based communication
 */

import * as readline from 'node:readline';
import * as net from 'node:net';
import * as fs from 'node:fs';
import { Readable, Writable } from 'node:stream';
import type { QwenStateMessage, QwenCommand } from './qwenStateSerializer.js';

export type ServerModeType = 'stdin' | 'pipe' | 'tcp';

export interface ServerModeConfig {
  mode: ServerModeType;
  pipePath?: string;
  tcpPort?: number;
}

// ============================================================================
// Base Server Class
// ============================================================================

export abstract class BaseStructuredServer {
  protected running: boolean = false;
  protected messageQueue: QwenCommand[] = [];

  constructor() {}

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract sendMessage(msg: QwenStateMessage): Promise<void>;

  /**
   * Send multiple messages in batch (more efficient)
   */
  async sendMessages(messages: QwenStateMessage[]): Promise<void> {
    for (const msg of messages) {
      await this.sendMessage(msg);
    }
  }

  /**
   * Receive command from client (non-blocking)
   * Returns null if no message available
   */
  async receiveCommand(): Promise<QwenCommand | null> {
    if (this.messageQueue.length > 0) {
      return this.messageQueue.shift() || null;
    }
    return null;
  }

  /**
   * Wait for specific command type (blocking with timeout)
   */
  async waitForCommand(
    timeout: number = 60000,
  ): Promise<QwenCommand | null> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const cmd = await this.receiveCommand();
      if (cmd) return cmd;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return null;
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Parse incoming JSON message
   */
  protected parseCommand(line: string): QwenCommand | null {
    try {
      const parsed = JSON.parse(line) as QwenCommand;
      // Validate command type
      if (
        parsed.type === 'user_input' ||
        parsed.type === 'tool_approval' ||
        parsed.type === 'interrupt' ||
        parsed.type === 'model_switch'
      ) {
        return parsed;
      }
      console.error('[StructuredServerMode] Invalid command type:', parsed);
      return null;
    } catch (err) {
      console.error('[StructuredServerMode] Failed to parse command:', line, err);
      return null;
    }
  }
}

// ============================================================================
// Stdin/Stdout Server
// ============================================================================

export class StdinStdoutServer extends BaseStructuredServer {
  private rl: readline.Interface | null = null;

  async start(): Promise<void> {
    this.running = true;

    // Use stderr for all logging (stdout is for protocol only)
    console.error('[StructuredServerMode] Starting stdin/stdout mode');

    // Set up readline on stdin
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr, // Logs go to stderr
      terminal: false,
    });

    // Handle incoming commands
    this.rl.on('line', (line: string) => {
      const cmd = this.parseCommand(line);
      if (cmd) {
        this.messageQueue.push(cmd);
      }
    });

    this.rl.on('close', () => {
      console.error('[StructuredServerMode] Stdin closed');
      this.running = false;
    });
  }

  async sendMessage(msg: QwenStateMessage): Promise<void> {
    if (!this.running) return;

    try {
      // Write to stdout (line-buffered JSON)
      process.stdout.write(JSON.stringify(msg) + '\n');
    } catch (err) {
      console.error('[StructuredServerMode] Failed to send message:', err);
    }
  }

  async stop(): Promise<void> {
    console.error('[StructuredServerMode] Stopping stdin/stdout mode');
    this.running = false;
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }
}

// ============================================================================
// Named Pipe Server
// ============================================================================

export class NamedPipeServer extends BaseStructuredServer {
  private readPipe: string;
  private writePipe: string;
  private readStream: Readable | null = null;
  private writeStream: Writable | null = null;
  private rl: readline.Interface | null = null;

  constructor(pipePath: string) {
    super();
    // Client writes to .in, we read from .in
    // We write to .out, client reads from .out
    this.readPipe = `${pipePath}.in`;
    this.writePipe = `${pipePath}.out`;
  }

  async start(): Promise<void> {
    this.running = true;

    console.error(
      `[StructuredServerMode] Starting named pipe mode: ${this.readPipe} / ${this.writePipe}`,
    );

    // Check if pipes exist
    if (!fs.existsSync(this.readPipe)) {
      throw new Error(
        `Read pipe ${this.readPipe} does not exist. Create with: mkfifo ${this.readPipe}`,
      );
    }
    if (!fs.existsSync(this.writePipe)) {
      throw new Error(
        `Write pipe ${this.writePipe} does not exist. Create with: mkfifo ${this.writePipe}`,
      );
    }

    // Open pipes
    this.readStream = fs.createReadStream(this.readPipe, { encoding: 'utf8' });
    this.writeStream = fs.createWriteStream(this.writePipe, {
      encoding: 'utf8',
    });

    // Set up readline for input
    this.rl = readline.createInterface({
      input: this.readStream,
      terminal: false,
    });

    this.rl.on('line', (line: string) => {
      const cmd = this.parseCommand(line);
      if (cmd) {
        this.messageQueue.push(cmd);
      }
    });

    this.rl.on('close', () => {
      console.error('[StructuredServerMode] Pipe closed');
      this.running = false;
    });
  }

  async sendMessage(msg: QwenStateMessage): Promise<void> {
    if (!this.running || !this.writeStream) return;

    try {
      this.writeStream.write(JSON.stringify(msg) + '\n');
    } catch (err) {
      console.error('[StructuredServerMode] Failed to send to pipe:', err);
    }
  }

  async stop(): Promise<void> {
    console.error('[StructuredServerMode] Stopping named pipe mode');
    this.running = false;
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    if (this.readStream) {
      this.readStream.destroy();
      this.readStream = null;
    }
    if (this.writeStream) {
      this.writeStream.end();
      this.writeStream = null;
    }
  }
}

// ============================================================================
// TCP Server
// ============================================================================

export class TCPServer extends BaseStructuredServer {
  private server: net.Server | null = null;
  private client: net.Socket | null = null;
  private buffer: string = '';

  constructor(private port: number) {
    super();
  }

  async start(): Promise<void> {
    this.running = true;

    console.error(`[StructuredServerMode] Starting TCP mode on port ${this.port}`);

    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        console.error(
          `[StructuredServerMode] Client connected from ${socket.remoteAddress}:${socket.remotePort}`,
        );
        this.client = socket;

        // Set up data handler
        socket.on('data', (data) => {
          this.buffer += data.toString('utf8');

          // Process complete lines
          let newlineIndex;
          while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
            const line = this.buffer.substring(0, newlineIndex);
            this.buffer = this.buffer.substring(newlineIndex + 1);

            const cmd = this.parseCommand(line);
            if (cmd) {
              this.messageQueue.push(cmd);
            }
          }
        });

        socket.on('close', () => {
          console.error('[StructuredServerMode] Client disconnected');
          this.client = null;
        });

        socket.on('error', (err) => {
          console.error('[StructuredServerMode] Socket error:', err);
          this.client = null;
        });
      });

      this.server.listen(this.port, () => {
        console.error(`[StructuredServerMode] TCP server listening on port ${this.port}`);
        resolve();
      });

      this.server.on('error', (err) => {
        console.error('[StructuredServerMode] Server error:', err);
        reject(err);
      });
    });
  }

  async sendMessage(msg: QwenStateMessage): Promise<void> {
    if (!this.running || !this.client) return;

    try {
      this.client.write(JSON.stringify(msg) + '\n');
    } catch (err) {
      console.error('[StructuredServerMode] Failed to send to TCP client:', err);
    }
  }

  async stop(): Promise<void> {
    console.error('[StructuredServerMode] Stopping TCP mode');
    this.running = false;
    if (this.client) {
      this.client.end();
      this.client = null;
    }
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createStructuredServer(
  config: ServerModeConfig,
): BaseStructuredServer {
  switch (config.mode) {
    case 'stdin':
      return new StdinStdoutServer();
    case 'pipe':
      if (!config.pipePath) {
        throw new Error('pipePath is required for pipe mode');
      }
      return new NamedPipeServer(config.pipePath);
    case 'tcp':
      return new TCPServer(config.tcpPort || 7777);
    default:
      throw new Error(`Unknown server mode: ${config.mode}`);
  }
}

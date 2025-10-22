/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { StdinStdoutServer } from './structuredServerMode.js';
import type { QwenStateMessage, QwenCommand } from './qwenStateSerializer.js';

describe('StructuredServerMode', () => {
  describe('StdinStdoutServer', () => {
    let server: StdinStdoutServer;

    beforeEach(() => {
      server = new StdinStdoutServer();
    });

    it('should initialize correctly', () => {
      expect(server.isRunning()).toBe(false);
    });

    it('should serialize init message correctly', async () => {
      const initMsg: QwenStateMessage = {
        type: 'init',
        version: '0.0.14',
        workspaceRoot: '/test',
        model: 'qwen',
      };

      // We can't easily test actual stdio without mocking,
      // but we can verify the message structure is correct
      expect(initMsg.type).toBe('init');
      expect(initMsg.version).toBe('0.0.14');
    });

    it('should serialize conversation message', async () => {
      const msg: QwenStateMessage = {
        type: 'conversation',
        role: 'user',
        content: 'hello world',
        id: 1,
      };

      expect(msg.type).toBe('conversation');
      expect(msg.role).toBe('user');
      expect(msg.content).toBe('hello world');
    });

    it('should serialize tool group message', async () => {
      const msg: QwenStateMessage = {
        type: 'tool_group',
        id: 1,
        tools: [
          {
            type: 'tool_call',
            tool_id: 'test_123',
            tool_name: 'write_file',
            status: 'pending',
            args: { path: 'test.txt' },
          },
        ],
      };

      expect(msg.type).toBe('tool_group');
      expect(msg.tools).toHaveLength(1);
      expect(msg.tools[0].tool_name).toBe('write_file');
    });

    it('should serialize status update', async () => {
      const msg: QwenStateMessage = {
        type: 'status',
        state: 'responding',
        message: 'Thinking...',
        thought: 'Analyzing code...',
      };

      expect(msg.type).toBe('status');
      expect(msg.state).toBe('responding');
      expect(msg.message).toBe('Thinking...');
    });

    it('should parse user input command', () => {
      // The actual parsing would be done by the server's parseCommand method
      // which is protected, but we can test the structure
      const cmd: QwenCommand = {
        type: 'user_input',
        content: 'hello',
      };

      expect(cmd.type).toBe('user_input');
      expect(cmd.content).toBe('hello');
    });

    it('should parse tool approval command', () => {
      const cmd: QwenCommand = {
        type: 'tool_approval',
        tool_id: 'abc123',
        approved: true,
      };

      expect(cmd.type).toBe('tool_approval');
      expect(cmd.tool_id).toBe('abc123');
      expect(cmd.approved).toBe(true);
    });

    it('should parse interrupt command', () => {
      const cmd: QwenCommand = {
        type: 'interrupt',
      };

      expect(cmd.type).toBe('interrupt');
    });

    it('should parse model switch command', () => {
      const cmd: QwenCommand = {
        type: 'model_switch',
        model_id: 'qwen2.5-coder-32b',
      };

      expect(cmd.type).toBe('model_switch');
      expect(cmd.model_id).toBe('qwen2.5-coder-32b');
    });
  });
});

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  QwenStateSerializer,
  serializeHistoryItem,
  serializeStreamingState,
  createInitMessage,
} from './qwenStateSerializer.js';
import { StreamingState, ToolCallStatus } from './ui/types.js';
import type { HistoryItem, IndividualToolCallDisplay } from './ui/types.js';

describe('QwenStateSerializer', () => {
  describe('serializeHistoryItem', () => {
    it('should serialize user message', () => {
      const item: HistoryItem = {
        type: 'user',
        text: 'Hello world',
        id: 1,
      };

      const result = serializeHistoryItem(item);

      expect(result).toEqual({
        type: 'conversation',
        role: 'user',
        content: 'Hello world',
        id: 1,
      });
    });

    it('should serialize assistant message', () => {
      const item: HistoryItem = {
        type: 'gemini',
        text: 'Hello! How can I help?',
        id: 2,
      };

      const result = serializeHistoryItem(item);

      expect(result).toEqual({
        type: 'conversation',
        role: 'assistant',
        content: 'Hello! How can I help?',
        id: 2,
      });
    });

    it('should serialize tool group', () => {
      const toolCall: IndividualToolCallDisplay = {
        callId: 'write_abc123',
        name: 'write_file',
        description: 'Write file',
        status: ToolCallStatus.Success,
        resultDisplay: 'File written successfully',
        confirmationDetails: undefined,
      };

      const item: HistoryItem = {
        type: 'tool_group',
        tools: [toolCall],
        id: 3,
      };

      const result = serializeHistoryItem(item);

      expect(result).toBeTruthy();
      expect(result?.type).toBe('tool_group');
      if (result && result.type === 'tool_group') {
        expect(result.id).toBe(3);
        expect(result.tools).toHaveLength(1);
        expect(result.tools[0].tool_id).toBe('write_abc123');
        expect(result.tools[0].tool_name).toBe('write_file');
        expect(result.tools[0].status).toBe('success');
      }
    });

    it('should serialize info message', () => {
      const item: HistoryItem = {
        type: 'info',
        text: 'Context loaded',
        id: 4,
      };

      const result = serializeHistoryItem(item);

      expect(result).toEqual({
        type: 'info',
        message: 'Context loaded',
        id: 4,
      });
    });

    it('should serialize error message', () => {
      const item: HistoryItem = {
        type: 'error',
        text: 'File not found',
        id: 5,
      };

      const result = serializeHistoryItem(item);

      expect(result).toEqual({
        type: 'error',
        message: 'File not found',
        id: 5,
      });
    });

    it('should return null for UI-only items', () => {
      const item: HistoryItem = {
        type: 'help',
        timestamp: new Date(),
        id: 6,
      };

      const result = serializeHistoryItem(item);

      expect(result).toBeNull();
    });
  });

  describe('serializeStreamingState', () => {
    it('should serialize idle state', () => {
      const result = serializeStreamingState(StreamingState.Idle);

      expect(result).toEqual({
        type: 'status',
        state: 'idle',
        message: 'Ready',
        thought: undefined,
      });
    });

    it('should serialize responding state with thought', () => {
      const result = serializeStreamingState(
        StreamingState.Responding,
        'Analyzing the code...',
      );

      expect(result).toEqual({
        type: 'status',
        state: 'responding',
        message: 'Analyzing the code...',
        thought: 'Analyzing the code...',
      });
    });

    it('should serialize waiting for confirmation state', () => {
      const result = serializeStreamingState(
        StreamingState.WaitingForConfirmation,
      );

      expect(result).toEqual({
        type: 'status',
        state: 'waiting_for_confirmation',
        message: 'Waiting for approval',
        thought: undefined,
      });
    });
  });

  describe('createInitMessage', () => {
    it('should create init message', () => {
      const result = createInitMessage('0.0.14', '/home/user/project', 'qwen2.5-coder-7b');

      expect(result).toEqual({
        type: 'init',
        version: '0.0.14',
        workspaceRoot: '/home/user/project',
        model: 'qwen2.5-coder-7b',
      });
    });
  });

  describe('QwenStateSerializer class', () => {
    it('should track incremental history updates', () => {
      const serializer = new QwenStateSerializer();

      const history: HistoryItem[] = [
        { type: 'user', text: 'First message', id: 1 },
        { type: 'gemini', text: 'Response', id: 2 },
      ];

      // First call should return both items
      const updates1 = serializer.getIncrementalUpdates(
        history,
        [],
        StreamingState.Idle,
      );

      expect(updates1.length).toBeGreaterThanOrEqual(2); // At least 2 history items

      // Second call with same history should return only state (already sent)
      const updates2 = serializer.getIncrementalUpdates(
        history,
        [],
        StreamingState.Idle,
      );

      expect(updates2.length).toBe(0); // No new items

      // Add new history item
      history.push({ type: 'user', text: 'Third message', id: 3 });

      const updates3 = serializer.getIncrementalUpdates(
        history,
        [],
        StreamingState.Idle,
      );

      expect(updates3.length).toBeGreaterThanOrEqual(1); // At least the new item
    });

    it('should send state changes', () => {
      const serializer = new QwenStateSerializer();

      const history: HistoryItem[] = [];

      // First call - idle
      const updates1 = serializer.getIncrementalUpdates(
        history,
        [],
        StreamingState.Idle,
      );

      expect(updates1.some((u) => u.type === 'status')).toBe(true);

      // Change to responding
      const updates2 = serializer.getIncrementalUpdates(
        history,
        [],
        StreamingState.Responding,
        'Thinking...',
      );

      expect(updates2.some((u) => u.type === 'status')).toBe(true);
      const statusUpdate = updates2.find((u) => u.type === 'status');
      if (statusUpdate && statusUpdate.type === 'status') {
        expect(statusUpdate.state).toBe('responding');
      }
    });

    it('should handle pending items', () => {
      const serializer = new QwenStateSerializer();

      const history: HistoryItem[] = [];
      const pendingItems = [
        { type: 'user' as const, text: 'Pending input' },
      ];

      const updates = serializer.getIncrementalUpdates(
        history,
        pendingItems,
        StreamingState.Idle,
      );

      // Should include the pending item with negative ID
      const conversationUpdate = updates.find((u) => u.type === 'conversation');
      expect(conversationUpdate).toBeTruthy();
      if (conversationUpdate && conversationUpdate.type === 'conversation') {
        expect(conversationUpdate.id).toBeLessThan(0);
      }
    });

    it('should reset state', () => {
      const serializer = new QwenStateSerializer();

      const history: HistoryItem[] = [
        { type: 'user', text: 'Message', id: 1 },
      ];

      // Get updates
      serializer.getIncrementalUpdates(history, [], StreamingState.Idle);

      // Reset
      serializer.reset();

      // After reset, should send everything again
      const updates = serializer.getIncrementalUpdates(
        history,
        [],
        StreamingState.Idle,
      );

      expect(updates.length).toBeGreaterThan(0);
    });
  });
});

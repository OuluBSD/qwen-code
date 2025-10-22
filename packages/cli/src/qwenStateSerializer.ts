/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Qwen State Serializer - Converts qwen-code application state to structured JSON
 * for external thick clients (like VfsBoot C++)
 *
 * Instead of sending terminal rendering, we send semantic application events:
 * - Conversation messages (user/assistant)
 * - Tool executions (file operations, shell commands, etc.)
 * - Application state changes (idle, thinking, waiting for approval)
 * - UI events (dialogs, confirmations, etc.)
 */

import type {
  HistoryItem,
  HistoryItemWithoutId,
  StreamingState,
  ToolCallStatus,
  IndividualToolCallDisplay,
} from './ui/types.js';

// ============================================================================
// Protocol Message Types (TypeScript → C++)
// ============================================================================

export interface QwenInitMessage {
  type: 'init';
  version: string;
  workspaceRoot: string;
  model: string;
}

export interface QwenConversationMessage {
  type: 'conversation';
  role: 'user' | 'assistant' | 'system';
  content: string;
  id: number;
  timestamp?: number;
}

export interface QwenToolCall {
  type: 'tool_call';
  tool_id: string;
  tool_name: string;
  status: 'pending' | 'confirming' | 'executing' | 'success' | 'error' | 'canceled';
  args: Record<string, unknown>;
  result?: string;
  error?: string;
  confirmation_details?: {
    message: string;
    requires_approval: boolean;
  };
}

export interface QwenToolGroup {
  type: 'tool_group';
  id: number;
  tools: QwenToolCall[];
}

export interface QwenStatusUpdate {
  type: 'status';
  state: 'idle' | 'responding' | 'waiting_for_confirmation';
  message?: string;
  thought?: string;
}

export interface QwenInfoMessage {
  type: 'info';
  message: string;
  id: number;
}

export interface QwenErrorMessage {
  type: 'error';
  message: string;
  id: number;
}

export interface QwenCompletionStats {
  type: 'completion_stats';
  duration: string;
  prompt_tokens?: number;
  completion_tokens?: number;
}

export type QwenStateMessage =
  | QwenInitMessage
  | QwenConversationMessage
  | QwenToolGroup
  | QwenStatusUpdate
  | QwenInfoMessage
  | QwenErrorMessage
  | QwenCompletionStats;

// ============================================================================
// C++ → TypeScript Command Messages
// ============================================================================

export interface QwenUserInput {
  type: 'user_input';
  content: string;
}

export interface QwenToolApproval {
  type: 'tool_approval';
  tool_id: string;
  approved: boolean;
}

export interface QwenInterrupt {
  type: 'interrupt';
}

export interface QwenModelSwitch {
  type: 'model_switch';
  model_id: string;
}

export type QwenCommand =
  | QwenUserInput
  | QwenToolApproval
  | QwenInterrupt
  | QwenModelSwitch;

// ============================================================================
// Serialization Functions
// ============================================================================

/**
 * Convert ToolCallStatus enum to protocol string
 */
function mapToolStatus(status: ToolCallStatus): QwenToolCall['status'] {
  switch (status) {
    case ToolCallStatus.Pending:
      return 'pending';
    case ToolCallStatus.Confirming:
      return 'confirming';
    case ToolCallStatus.Executing:
      return 'executing';
    case ToolCallStatus.Success:
      return 'success';
    case ToolCallStatus.Error:
      return 'error';
    case ToolCallStatus.Canceled:
      return 'canceled';
    default:
      return 'pending';
  }
}

/**
 * Serialize a single tool call
 */
function serializeToolCall(tool: IndividualToolCallDisplay): QwenToolCall {
  return {
    type: 'tool_call',
    tool_id: tool.callId,
    tool_name: tool.name,
    status: mapToolStatus(tool.status),
    args: {}, // Tool args not exposed in display type
    result:
      typeof tool.resultDisplay === 'string'
        ? tool.resultDisplay
        : tool.resultDisplay?.message,
    confirmation_details: tool.confirmationDetails
      ? {
          message: tool.confirmationDetails.message || '',
          requires_approval: tool.confirmationDetails.requiresConfirmation,
        }
      : undefined,
  };
}

/**
 * Serialize a history item to protocol message
 */
export function serializeHistoryItem(
  item: HistoryItem,
): QwenStateMessage | null {
  switch (item.type) {
    case 'user':
    case 'user_shell':
      return {
        type: 'conversation',
        role: 'user',
        content: item.text,
        id: item.id,
      };

    case 'gemini':
    case 'gemini_content':
      return {
        type: 'conversation',
        role: 'assistant',
        content: item.text,
        id: item.id,
      };

    case 'tool_group':
      return {
        type: 'tool_group',
        id: item.id,
        tools: item.tools.map(serializeToolCall),
      };

    case 'info':
      return {
        type: 'info',
        message: item.text,
        id: item.id,
      };

    case 'error':
      return {
        type: 'error',
        message: item.text,
        id: item.id,
      };

    case 'stats':
      return {
        type: 'completion_stats',
        duration: item.duration,
      };

    // Ignore UI-specific items that don't need to be sent to C++
    case 'about':
    case 'help':
    case 'model_stats':
    case 'tool_stats':
    case 'quit':
    case 'quit_confirmation':
    case 'compression':
    case 'summary':
      return null;

    default:
      return null;
  }
}

/**
 * Serialize StreamingState to status update
 */
export function serializeStreamingState(
  state: StreamingState,
  thought?: string,
): QwenStatusUpdate {
  let stateStr: QwenStatusUpdate['state'];
  let message: string | undefined;

  switch (state) {
    case StreamingState.Idle:
      stateStr = 'idle';
      message = 'Ready';
      break;
    case StreamingState.Responding:
      stateStr = 'responding';
      message = thought || 'Thinking...';
      break;
    case StreamingState.WaitingForConfirmation:
      stateStr = 'waiting_for_confirmation';
      message = 'Waiting for approval';
      break;
    default:
      stateStr = 'idle';
  }

  return {
    type: 'status',
    state: stateStr,
    message,
    thought,
  };
}

/**
 * Create init message
 */
export function createInitMessage(
  version: string,
  workspaceRoot: string,
  model: string,
): QwenInitMessage {
  return {
    type: 'init',
    version,
    workspaceRoot,
    model,
  };
}

/**
 * State Serializer Class
 * Tracks application state and generates incremental updates
 */
export class QwenStateSerializer {
  private lastHistoryLength = 0;
  private lastStreamingState: StreamingState | null = null;

  /**
   * Get incremental updates since last call
   * Returns only new history items and state changes
   */
  getIncrementalUpdates(
    history: HistoryItem[],
    pendingItems: HistoryItemWithoutId[],
    streamingState: StreamingState,
    thought?: string,
  ): QwenStateMessage[] {
    const messages: QwenStateMessage[] = [];

    // Send new history items
    if (history.length > this.lastHistoryLength) {
      const newItems = history.slice(this.lastHistoryLength);
      for (const item of newItems) {
        const serialized = serializeHistoryItem(item);
        if (serialized) {
          messages.push(serialized);
        }
      }
      this.lastHistoryLength = history.length;
    }

    // Send pending items (currently executing tools/messages)
    // These don't have IDs yet, so we generate temporary ones
    for (let i = 0; i < pendingItems.length; i++) {
      const item = pendingItems[i];
      const tempId = -(i + 1); // Negative IDs for pending items
      const itemWithId = { ...item, id: tempId } as HistoryItem;
      const serialized = serializeHistoryItem(itemWithId);
      if (serialized) {
        messages.push(serialized);
      }
    }

    // Send streaming state changes
    if (streamingState !== this.lastStreamingState) {
      messages.push(serializeStreamingState(streamingState, thought));
      this.lastStreamingState = streamingState;
    }

    return messages;
  }

  /**
   * Get full state snapshot (for initialization)
   */
  getFullState(
    history: HistoryItem[],
    streamingState: StreamingState,
    thought?: string,
  ): QwenStateMessage[] {
    const messages: QwenStateMessage[] = [];

    // Send all history
    for (const item of history) {
      const serialized = serializeHistoryItem(item);
      if (serialized) {
        messages.push(serialized);
      }
    }

    // Send current state
    messages.push(serializeStreamingState(streamingState, thought));

    this.lastHistoryLength = history.length;
    this.lastStreamingState = streamingState;

    return messages;
  }

  /**
   * Reset serializer state
   */
  reset(): void {
    this.lastHistoryLength = 0;
    this.lastStreamingState = null;
  }
}

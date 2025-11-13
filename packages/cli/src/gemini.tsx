/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { render } from 'ink';
import { AppContainer } from './ui/AppContainer.js';
import { loadCliConfig, parseArguments } from './config/config.js';
import * as cliConfig from './config/config.js';
import { readStdin } from './utils/readStdin.js';
import { basename } from 'node:path';
import v8 from 'node:v8';
import os from 'node:os';
import dns from 'node:dns';
import { randomUUID } from 'node:crypto';
import { start_sandbox } from './utils/sandbox.js';
import type { DnsResolutionOrder, LoadedSettings } from './config/settings.js';
import { loadSettings, migrateDeprecatedSettings } from './config/settings.js';
import { themeManager } from './ui/themes/theme-manager.js';
import { getStartupWarnings } from './utils/startupWarnings.js';
import { getUserStartupWarnings } from './utils/userStartupWarnings.js';
import { ConsolePatcher } from './ui/utils/ConsolePatcher.js';
import { runNonInteractive } from './nonInteractiveCli.js';
import { ExtensionStorage, loadExtensions } from './config/extension.js';
import {
  cleanupCheckpoints,
  registerCleanup,
  runExitCleanup,
} from './utils/cleanup.js';
import { getCliVersion } from './utils/version.js';
import type { Config } from '@qwen-code/qwen-code-core';
import {
  AuthType,
  getOauthClient,
  logUserPrompt,
  GeminiEventType,
} from '@qwen-code/qwen-code-core';
import {
  initializeApp,
  type InitializationResult,
} from './core/initializer.js';
import { validateAuthMethod } from './config/auth.js';
import { setMaxSizedBoxDebugging } from './ui/components/shared/MaxSizedBox.js';
import { SettingsContext } from './ui/contexts/SettingsContext.js';
import { detectAndEnableKittyProtocol } from './ui/utils/kittyProtocolDetector.js';
import { checkForUpdates } from './ui/utils/updateCheck.js';
import { handleAutoUpdate } from './utils/handleAutoUpdate.js';
import { computeWindowTitle } from './utils/windowTitle.js';
import { SessionStatsProvider } from './ui/contexts/SessionContext.js';
import { VimModeProvider } from './ui/contexts/VimModeContext.js';
import { KeypressProvider } from './ui/contexts/KeypressContext.js';
import { appEvents, AppEvent } from './utils/events.js';
import { useKittyKeyboardProtocol } from './ui/hooks/useKittyKeyboardProtocol.js';
import {
  relaunchOnExitCode,
  relaunchAppInChildProcess,
} from './utils/relaunch.js';
import { validateNonInteractiveAuth } from './validateNonInterActiveAuth.js';
import { runZedIntegration } from './zed-integration/zedIntegration.js';
import { createStructuredServer } from './structuredServerMode.js';
import type { BaseStructuredServer } from './structuredServerMode.js';
import { createInitMessage } from './qwenStateSerializer.js';

export function validateDnsResolutionOrder(
  order: string | undefined,
): DnsResolutionOrder {
  const defaultValue: DnsResolutionOrder = 'ipv4first';
  if (order === undefined) {
    return defaultValue;
  }
  if (order === 'ipv4first' || order === 'verbatim') {
    return order;
  }
  // We don't want to throw here, just warn and use the default.
  console.warn(
    `Invalid value for dnsResolutionOrder in settings: "${order}". Using default "${defaultValue}".`,
  );
  return defaultValue;
}

function getNodeMemoryArgs(isDebugMode: boolean): string[] {
  const totalMemoryMB = os.totalmem() / (1024 * 1024);
  const heapStats = v8.getHeapStatistics();
  const currentMaxOldSpaceSizeMb = Math.floor(
    heapStats.heap_size_limit / 1024 / 1024,
  );

  // Set target to 50% of total memory
  const targetMaxOldSpaceSizeInMB = Math.floor(totalMemoryMB * 0.5);
  if (isDebugMode) {
    console.debug(
      `Current heap size ${currentMaxOldSpaceSizeMb.toFixed(2)} MB`,
    );
  }

  if (process.env['GEMINI_CLI_NO_RELAUNCH']) {
    return [];
  }

  if (targetMaxOldSpaceSizeInMB > currentMaxOldSpaceSizeMb) {
    if (isDebugMode) {
      console.debug(
        `Need to relaunch with more memory: ${targetMaxOldSpaceSizeInMB.toFixed(2)} MB`,
      );
    }
    return [`--max-old-space-size=${targetMaxOldSpaceSizeInMB}`];
  }

  return [];
}

import { runZedIntegration } from './zed-integration/zedIntegration.js';
import { loadSandboxConfig } from './config/sandboxConfig.js';
import { ExtensionEnablementManager } from './config/extensions/extensionEnablement.js';

export function setupUnhandledRejectionHandler() {
  let unhandledRejectionOccurred = false;
  process.on('unhandledRejection', (reason, _promise) => {
    const errorMessage = `=========================================
This is an unexpected error. Please file a bug report using the /bug tool.
CRITICAL: Unhandled Promise Rejection!
=========================================
Reason: ${reason}${
      reason instanceof Error && reason.stack
        ? `
Stack trace:
${reason.stack}`
        : ''
    }`;
    appEvents.emit(AppEvent.LogError, errorMessage);
    if (!unhandledRejectionOccurred) {
      unhandledRejectionOccurred = true;
      appEvents.emit(AppEvent.OpenDebugConsole);
    }
  });
}

export async function startInteractiveUI(
  config: Config,
  settings: LoadedSettings,
  startupWarnings: string[],
  workspaceRoot: string = process.cwd(),
  initializationResult: InitializationResult,
) {
  const version = await getCliVersion();
  setWindowTitle(basename(workspaceRoot), settings);

  // Create wrapper component to use hooks inside render
  const AppWrapper = () => {
    const kittyProtocolStatus = useKittyKeyboardProtocol();
    const nodeMajorVersion = parseInt(process.versions.node.split('.')[0], 10);
    return (
      <SettingsContext.Provider value={settings}>
        <KeypressProvider
          kittyProtocolEnabled={kittyProtocolStatus.enabled}
          config={config}
          debugKeystrokeLogging={settings.merged.general?.debugKeystrokeLogging}
          pasteWorkaround={
            process.platform === 'win32' || nodeMajorVersion < 20
          }
        >
          <SessionStatsProvider>
            <VimModeProvider settings={settings}>
              <AppContainer
                config={config}
                settings={settings}
                startupWarnings={startupWarnings}
                version={version}
                initializationResult={initializationResult}
              />
            </VimModeProvider>
          </SessionStatsProvider>
        </KeypressProvider>
      </SettingsContext.Provider>
    );
  };

  const instance = render(
    process.env['DEBUG'] ? (
      <React.StrictMode>
        <AppWrapper />
      </React.StrictMode>
    ) : (
      <AppWrapper />
    ),
    {
      exitOnCtrlC: false,
      isScreenReaderEnabled: config.getScreenReader(),
    },
  );

  checkForUpdates()
    .then((info) => {
      handleAutoUpdate(info, settings, config.getProjectRoot());
    })
    .catch((err) => {
      // Silently ignore update check errors.
      if (config.getDebugMode()) {
        console.error('Update check failed:', err);
      }
    });

  registerCleanup(() => instance.unmount());
}

/**
 * Run in server mode - Sends structured semantic data to external frontend
 */
export async function runServerMode(
  config: Config,
  settings: LoadedSettings,
  startupWarnings: string[],
  workspaceRoot: string,
  server: BaseStructuredServer,
) {
  const version = await getCliVersion();

  console.error('[ServerMode] Starting structured server mode');
  console.error('[ServerMode] Version:', version);
  console.error('[ServerMode] Workspace:', workspaceRoot);
  console.error('[ServerMode] Model:', config.getModel());

  // Send init message
  const initMsg = createInitMessage(
    version,
    workspaceRoot,
    config.getModel(),
  );
  await server.sendMessage(initMsg);

  // Get GeminiClient from config
  const geminiClient = config.getGeminiClient();
  console.error('[ServerMode] GeminiClient check:', {
    exists: !!geminiClient,
    isInitialized: geminiClient ? geminiClient.isInitialized() : false,
    model: config.getModel(),
    authConfig: config.getContentGeneratorConfig()?.authType,
  });

  if (!geminiClient || !geminiClient.isInitialized()) {
    console.error('[ServerMode] ERROR: GeminiClient not available or not initialized');
    console.error('[ServerMode] This should not happen - auth was initialized before runServerMode');
    await server.sendMessage({
      type: 'error',
      message: 'GeminiClient not initialized - internal error',
      id: Date.now(),
    });
    await server.stop();
    return;
  }

  console.error('[ServerMode] Server mode is running with real AI...');
  console.error('[ServerMode] Waiting for user input...');

  // Track pending tool calls for approval flow
  const pendingToolCalls = new Map<string, any>();
  let currentAbortController: AbortController | null = null;

  // Main server loop - process commands from C++ client
  while (server.isRunning()) {
    const cmd = await server.receiveCommand();
    if (!cmd) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }

    console.error('[ServerMode] Received command:', cmd.type);

    if (cmd.type === 'user_input') {
      // Echo user input
      await server.sendMessage({
        type: 'conversation',
        role: 'user',
        content: cmd.content,
        id: Date.now(),
      });

      // Send status update
      await server.sendMessage({
        type: 'status',
        state: 'responding',
        message: 'Processing your request...',
      });

      // Create abort controller for this request
      currentAbortController = new AbortController();
      const promptId = `prompt-${Date.now()}`;

      try {
        // Call real AI with sendMessageStream
        const stream = geminiClient.sendMessageStream(
          cmd.content,
          currentAbortController.signal,
          promptId,
        );

        // Accumulate streaming content
        let contentBuffer = '';
        let messageId = Date.now();
        let hasStartedStreaming = false;

        // Process stream events
        for await (const event of stream) {
          if (currentAbortController.signal.aborted) {
            break;
          }

          switch (event.type) {
            case GeminiEventType.Content:
              // Streaming text content from AI
              contentBuffer += event.value;
              hasStartedStreaming = true;

              await server.sendMessage({
                type: 'conversation',
                role: 'assistant',
                content: event.value,
                id: messageId,
                isStreaming: true,
              });
              break;

            case GeminiEventType.Thought:
              // AI is thinking about something
              await server.sendMessage({
                type: 'status',
                state: 'responding',
                message: `Thinking: ${event.value.subject}`,
              });
              break;

            case GeminiEventType.ToolCallRequest:
              // AI wants to execute a tool
              const toolInfo = event.value;
              pendingToolCalls.set(toolInfo.callId, toolInfo);

              await server.sendMessage({
                type: 'tool_group',
                id: Date.now(),
                tools: [
                  {
                    type: 'tool_call',
                    tool_id: toolInfo.callId,
                    tool_name: toolInfo.name,
                    status: 'pending',
                    args: toolInfo.args,
                    confirmation_details: {
                      message: `Execute ${toolInfo.name} with args: ${JSON.stringify(toolInfo.args)}`,
                      requires_approval: true,
                    },
                  },
                ],
              });
              break;

            case GeminiEventType.Error:
              await server.sendMessage({
                type: 'error',
                message: event.value.error?.message || 'Unknown error',
                id: Date.now(),
              });
              break;

            case GeminiEventType.ChatCompressed:
              if (event.value) {
                await server.sendMessage({
                  type: 'info',
                  message: `Chat compressed: ${event.value.originalTokenCount} → ${event.value.newTokenCount} tokens`,
                  id: Date.now(),
                });
              }
              break;

            case GeminiEventType.Finished:
              // Stream finished
              if (hasStartedStreaming) {
                await server.sendMessage({
                  type: 'conversation',
                  role: 'assistant',
                  content: '',
                  id: messageId,
                  isStreaming: false,
                });
              }
              console.error(
                '[ServerMode] Stream finished. Reason:',
                event.value,
              );
              break;

            case GeminiEventType.UserCancelled:
              await server.sendMessage({
                type: 'info',
                message: 'Request cancelled by user',
                id: Date.now(),
              });
              break;

            case GeminiEventType.LoopDetected:
              await server.sendMessage({
                type: 'info',
                message: 'Loop detected - stopping to prevent infinite loop',
                id: Date.now(),
              });
              break;

            default:
              console.error('[ServerMode] Unhandled event type:', event.type);
          }
        }

        // TODO: Send completion stats if available from the turn
        // The stream returns a Turn object that contains token usage info
        // For now, we'll skip this as it requires accessing the return value

      } catch (error: any) {
        console.error('[ServerMode] Error during AI stream:', error);
        await server.sendMessage({
          type: 'error',
          message: error?.message || 'Unknown error during AI processing',
          id: Date.now(),
        });
      }
    } else if (cmd.type === 'tool_approval') {
      console.error('[ServerMode] Tool approval received:', cmd);

      const toolInfo = pendingToolCalls.get(cmd.tool_id);
      if (!toolInfo) {
        console.error('[ServerMode] Unknown tool_id:', cmd.tool_id);
        continue;
      }

      if (cmd.approved) {
        await server.sendMessage({
          type: 'status',
          state: 'responding',
          message: `Executing tool: ${toolInfo.name}...`,
        });

        try {
          // Execute the tool
          const { executeToolCall } = await import(
            '@qwen-code/qwen-code-core'
          );

          const toolResponse = await executeToolCall(
            config,
            toolInfo,
            new AbortController().signal,
          );

          // Send tool result notification
          await server.sendMessage({
            type: 'info',
            message: `Tool ${toolInfo.name} executed successfully`,
            id: Date.now(),
          });

          // Continue the AI conversation with tool results
          if (toolResponse.responseParts) {
            await server.sendMessage({
              type: 'status',
              state: 'responding',
              message: 'Processing tool results...',
            });

            // Create new stream with tool results as user message (Parts)
            const stream = geminiClient.sendMessageStream(
              toolResponse.responseParts,
              new AbortController().signal,
              `tool-result-${Date.now()}`,
            );

            // Process the new stream (same as original user_input handling)
            let contentBuffer = '';
            let messageId = Date.now();
            let hasStartedStreaming = false;

            for await (const event of stream) {
              switch (event.type) {
                case GeminiEventType.Content:
                  contentBuffer += event.value;
                  hasStartedStreaming = true;
                  await server.sendMessage({
                    type: 'conversation',
                    role: 'assistant',
                    content: event.value,
                    id: messageId,
                    isStreaming: true,
                  });
                  break;

                case GeminiEventType.ToolCallRequest:
                  const newToolInfo = event.value;
                  pendingToolCalls.set(newToolInfo.callId, newToolInfo);
                  await server.sendMessage({
                    type: 'tool_group',
                    id: Date.now(),
                    tools: [
                      {
                        type: 'tool_call',
                        tool_id: newToolInfo.callId,
                        tool_name: newToolInfo.name,
                        status: 'pending',
                        args: newToolInfo.args,
                        confirmation_details: {
                          message: `Execute ${newToolInfo.name} with args: ${JSON.stringify(newToolInfo.args)}`,
                          requires_approval: true,
                        },
                      },
                    ],
                  });
                  break;

                case GeminiEventType.Finished:
                  if (hasStartedStreaming) {
                    await server.sendMessage({
                      type: 'conversation',
                      role: 'assistant',
                      content: '',
                      id: messageId,
                      isStreaming: false,
                    });
                  }
                  console.error('[ServerMode] Tool result stream finished');
                  break;

                case GeminiEventType.Error:
                  await server.sendMessage({
                    type: 'error',
                    message: event.value.error?.message || 'Unknown error',
                    id: Date.now(),
                  });
                  break;
              }
            }
          }

          pendingToolCalls.delete(cmd.tool_id);
        } catch (error: any) {
          console.error('[ServerMode] Tool execution error:', error);
          await server.sendMessage({
            type: 'error',
            message: `Tool execution failed: ${error?.message || 'Unknown error'}`,
            id: Date.now(),
          });
          pendingToolCalls.delete(cmd.tool_id);
        }
      } else {
        await server.sendMessage({
          type: 'info',
          message: 'Tool execution cancelled by user',
          id: Date.now(),
        });
        pendingToolCalls.delete(cmd.tool_id);
      }
    } else if (cmd.type === 'interrupt') {
      console.error('[ServerMode] Interrupt received, shutting down');
      if (currentAbortController) {
        currentAbortController.abort();
      }
      break;
    }
  }

  await server.stop();
  console.error('[ServerMode] Server mode stopped');
}

export async function main() {
  setupUnhandledRejectionHandler();
  const settings = loadSettings();
  migrateDeprecatedSettings(settings);
  await cleanupCheckpoints();
  const sessionId = randomUUID();

  const argv = await parseArguments(settings.merged);

  // Check for invalid input combinations early to prevent crashes
  if (argv.promptInteractive && !process.stdin.isTTY) {
    console.error(
      'Error: The --prompt-interactive flag cannot be used when input is piped from stdin.',
    );
    process.exit(1);
  }

  const isDebugMode = cliConfig.isDebugMode(argv);
  const consolePatcher = new ConsolePatcher({
    stderr: true,
    debugMode: isDebugMode,
  });
  consolePatcher.patch();
  registerCleanup(consolePatcher.cleanup);

  dns.setDefaultResultOrder(
    validateDnsResolutionOrder(settings.merged.advanced?.dnsResolutionOrder),
  );

  // Load custom themes from settings
  themeManager.loadCustomThemes(settings.merged.ui?.customThemes);

  if (settings.merged.ui?.theme) {
    if (!themeManager.setActiveTheme(settings.merged.ui?.theme)) {
      // If the theme is not found during initial load, log a warning and continue.
      // The useThemeCommand hook in AppContainer.tsx will handle opening the dialog.
      console.warn(`Warning: Theme "${settings.merged.ui?.theme}" not found.`);
    }
  }

  // hop into sandbox if we are outside and sandboxing is enabled
  if (!process.env['SANDBOX']) {
    const memoryArgs = settings.merged.advanced?.autoConfigureMemory
      ? getNodeMemoryArgs(isDebugMode)
      : [];
    const sandboxConfig = await loadSandboxConfig(settings.merged, argv);
    // We intentially omit the list of extensions here because extensions
    // should not impact auth or setting up the sandbox.
    // TODO(jacobr): refactor loadCliConfig so there is a minimal version
    // that only initializes enough config to enable refreshAuth or find
    // another way to decouple refreshAuth from requiring a config.

    if (sandboxConfig) {
      const partialConfig = await loadCliConfig(
        settings.merged,
        [],
        new ExtensionEnablementManager(ExtensionStorage.getUserExtensionsDir()),
        sessionId,
        argv,
      );

      if (
        settings.merged.security?.auth?.selectedType &&
        !settings.merged.security?.auth?.useExternal
      ) {
        // Validate authentication here because the sandbox will interfere with the Oauth2 web redirect.
        try {
          const err = validateAuthMethod(
            settings.merged.security.auth.selectedType,
          );
          if (err) {
            throw new Error(err);
          }

          await partialConfig.refreshAuth(
            settings.merged.security.auth.selectedType,
          );
        } catch (err) {
          console.error('Error authenticating:', err);
          process.exit(1);
        }
      }
      let stdinData = '';
      if (!process.stdin.isTTY) {
        stdinData = await readStdin();
      }

      // This function is a copy of the one from sandbox.ts
      // It is moved here to decouple sandbox.ts from the CLI's argument structure.
      const injectStdinIntoArgs = (
        args: string[],
        stdinData?: string,
      ): string[] => {
        const finalArgs = [...args];
        if (stdinData) {
          const promptIndex = finalArgs.findIndex(
            (arg) => arg === '--prompt' || arg === '-p',
          );
          if (promptIndex > -1 && finalArgs.length > promptIndex + 1) {
            // If there's a prompt argument, prepend stdin to it
            finalArgs[promptIndex + 1] =
              `${stdinData}\n\n${finalArgs[promptIndex + 1]}`;
          } else {
            // If there's no prompt argument, add stdin as the prompt
            finalArgs.push('--prompt', stdinData);
          }
        }
        return finalArgs;
      };

      const sandboxArgs = injectStdinIntoArgs(process.argv, stdinData);

      await relaunchOnExitCode(() =>
        start_sandbox(sandboxConfig, memoryArgs, partialConfig, sandboxArgs),
      );
      process.exit(0);
    } else {
      // Relaunch app so we always have a child process that can be internally
      // restarted if needed.
      await relaunchAppInChildProcess(memoryArgs, []);
    }
  }

  // We are now past the logic handling potentially launching a child process
  // to run Gemini CLI. It is now safe to perform expensive initialization that
  // may have side effects.
  {
    const extensionEnablementManager = new ExtensionEnablementManager(
      ExtensionStorage.getUserExtensionsDir(),
      argv.extensions,
    );
    const extensions = loadExtensions(extensionEnablementManager);
    const config = await loadCliConfig(
      settings.merged,
      extensions,
      extensionEnablementManager,
      sessionId,
      argv,
    );

    if (config.getListExtensions()) {
      console.log('Installed extensions:');
      for (const extension of extensions) {
        console.log(`- ${extension.config.name}`);
      }
      process.exit(0);
    }

    const wasRaw = process.stdin.isRaw;
    let kittyProtocolDetectionComplete: Promise<boolean> | undefined;
    if (config.isInteractive() && !wasRaw && process.stdin.isTTY) {
      // Set this as early as possible to avoid spurious characters from
      // input showing up in the output.
      process.stdin.setRawMode(true);

      // This cleanup isn't strictly needed but may help in certain situations.
      process.on('SIGTERM', () => {
        process.stdin.setRawMode(wasRaw);
      });
      process.on('SIGINT', () => {
        process.stdin.setRawMode(wasRaw);
      });

      // Detect and enable Kitty keyboard protocol once at startup.
      kittyProtocolDetectionComplete = detectAndEnableKittyProtocol();
    }

    setMaxSizedBoxDebugging(isDebugMode);

    const initializationResult = await initializeApp(config, settings);

    if (
      settings.merged.security?.auth?.selectedType ===
        AuthType.LOGIN_WITH_GOOGLE &&
      config.isBrowserLaunchSuppressed()
    ) {
      // Do oauth before app renders to make copying the link possible.
      await getOauthClient(settings.merged.security.auth.selectedType, config);
    }

    if (config.getExperimentalZedIntegration()) {
      return runZedIntegration(config, settings, extensions, argv);
    }

    // Check for server mode
    if (argv.serverMode) {
      console.error('[ServerMode] Starting server mode');

      // Initialize authentication before starting server mode
      // Use config.getAuthType() first as it respects QWEN_AUTH_TYPE env var
      const authType = config.getAuthType() || settings.merged.security?.auth?.selectedType;
      if (authType) {
        console.error('[ServerMode] Initializing auth with type:', authType);
        try {
          await config.refreshAuth(authType);
          console.error('[ServerMode] Auth initialized successfully');
        } catch (error) {
          console.error('[ServerMode] Failed to initialize auth:', error);
          process.exit(1);
        }
      } else {
        console.error('[ServerMode] No auth type configured - checking environment');
        // Try to detect from environment variables (similar to validateNonInteractiveAuth)
        let detectedAuthType: AuthType | undefined;
        if (process.env['OPENAI_API_KEY']) {
          detectedAuthType = AuthType.USE_OPENAI;
        } else if (process.env['GEMINI_API_KEY']) {
          detectedAuthType = AuthType.USE_GEMINI;
        }

        if (detectedAuthType) {
          console.error('[ServerMode] Detected auth type from environment:', detectedAuthType);
          await config.refreshAuth(detectedAuthType);
        } else {
          console.error('[ServerMode] ERROR: No authentication configured');
          console.error('[ServerMode] Please set OPENAI_API_KEY or configure auth in settings');
          process.exit(1);
        }
      }

      console.error('[ServerMode] Auth config:', {
        authType: config.getContentGeneratorConfig()?.authType,
        hasGeminiClient: !!config.getGeminiClient(),
        geminiInitialized: config.getGeminiClient()?.isInitialized(),
      });

      const server = createStructuredServer({
        mode: argv.serverMode as 'stdin' | 'pipe' | 'tcp',
        pipePath: argv.pipePath,
        tcpPort: argv.tcpPort,
      });

      await server.start();

      const startupWarnings = [
        ...(await getStartupWarnings()),
        ...(await getUserStartupWarnings({
          workspaceRoot: process.cwd(),
          useRipgrep: settings.merged.tools?.useRipgrep ?? true,
          useBuiltinRipgrep: settings.merged.tools?.useBuiltinRipgrep ?? true,
        })),
      ];

      return runServerMode(config, settings, startupWarnings, process.cwd(), server);
    }

    let input = config.getQuestion();
    const startupWarnings = [
      ...(await getStartupWarnings()),
      ...(await getUserStartupWarnings({
        workspaceRoot: process.cwd(),
        useRipgrep: settings.merged.tools?.useRipgrep ?? true,
        useBuiltinRipgrep: settings.merged.tools?.useBuiltinRipgrep ?? true,
      })),
    ];

    // Render UI, passing necessary config values. Check that there is no command line question.
    if (config.isInteractive()) {
      // Need kitty detection to be complete before we can start the interactive UI.
      await kittyProtocolDetectionComplete;
      await startInteractiveUI(
        config,
        settings,
        startupWarnings,
        process.cwd(),
        initializationResult,
      );
      return;
    }

    await config.initialize();

    // If not a TTY, read from stdin
    if (!input) {
      console.error(
        `No input provided via stdin. Input can be provided by piping data into gemini or using the --prompt option.`,
      );
      process.exit(1);
    }
    }

    const prompt_id = Math.random().toString(16).slice(2);
    logUserPrompt(config, {
      'event.name': 'user_prompt',
      'event.timestamp': new Date().toISOString(),
      prompt: input,
      prompt_id,
      auth_type: config.getContentGeneratorConfig()?.authType,
      prompt_length: input.length,
    });

    const nonInteractiveConfig = await validateNonInteractiveAuth(
      settings.merged.security?.auth?.selectedType,
      settings.merged.security?.auth?.useExternal,
      config,
      settings,
    );

    if (config.getDebugMode()) {
      console.log('Session ID: %s', sessionId);
    }

    await runNonInteractive(nonInteractiveConfig, settings, input, prompt_id);
    // Call cleanup before process.exit, which causes cleanup to not run
    await runExitCleanup();
    process.exit(0);
  }
}

function setWindowTitle(title: string, settings: LoadedSettings) {
  if (!settings.merged.ui?.hideWindowTitle) {
    const windowTitle = computeWindowTitle(title);
    process.stdout.write(`\x1b]2;${windowTitle}\x07`);

    process.on('exit', () => {
      process.stdout.write(`\x1b]2;\x07`);
    });
  }
}

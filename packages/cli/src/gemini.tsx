/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core';
import {
  AuthType,
  FatalConfigError,
  getOauthClient,
  IdeConnectionEvent,
  IdeConnectionType,
  logIdeConnection,
  logUserPrompt,
  sessionId,
} from '@qwen-code/qwen-code-core';
import { render } from 'ink';
import { spawn } from 'node:child_process';
import dns from 'node:dns';
import os from 'node:os';
import { basename } from 'node:path';
import v8 from 'node:v8';
import React from 'react';
import { validateAuthMethod } from './config/auth.js';
import { loadCliConfig, parseArguments } from './config/config.js';
import { loadExtensions } from './config/extension.js';
import type { DnsResolutionOrder, LoadedSettings } from './config/settings.js';
import { loadSettings, SettingScope } from './config/settings.js';
import { runNonInteractive } from './nonInteractiveCli.js';
import { AppWrapper } from './ui/App.js';
import { setMaxSizedBoxDebugging } from './ui/components/shared/MaxSizedBox.js';
import { SettingsContext } from './ui/contexts/SettingsContext.js';
import { themeManager } from './ui/themes/theme-manager.js';
import { ConsolePatcher } from './ui/utils/ConsolePatcher.js';
import { detectAndEnableKittyProtocol } from './ui/utils/kittyProtocolDetector.js';
import { checkForUpdates } from './ui/utils/updateCheck.js';
import { cleanupCheckpoints, registerCleanup } from './utils/cleanup.js';
import { AppEvent, appEvents } from './utils/events.js';
import { handleAutoUpdate } from './utils/handleAutoUpdate.js';
import { readStdin } from './utils/readStdin.js';
import { start_sandbox } from './utils/sandbox.js';
import { getStartupWarnings } from './utils/startupWarnings.js';
import { getUserStartupWarnings } from './utils/userStartupWarnings.js';
import { getCliVersion } from './utils/version.js';
import { validateNonInteractiveAuth } from './validateNonInterActiveAuth.js';
import { runZedIntegration } from './zed-integration/zedIntegration.js';
import { createStructuredServer } from './structuredServerMode.js';
import type { BaseStructuredServer } from './structuredServerMode.js';
import {
  QwenStateSerializer,
  createInitMessage,
} from './qwenStateSerializer.js';

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

function getNodeMemoryArgs(config: Config): string[] {
  const totalMemoryMB = os.totalmem() / (1024 * 1024);
  const heapStats = v8.getHeapStatistics();
  const currentMaxOldSpaceSizeMb = Math.floor(
    heapStats.heap_size_limit / 1024 / 1024,
  );

  // Set target to 50% of total memory
  const targetMaxOldSpaceSizeInMB = Math.floor(totalMemoryMB * 0.5);
  if (config.getDebugMode()) {
    console.debug(
      `Current heap size ${currentMaxOldSpaceSizeMb.toFixed(2)} MB`,
    );
  }

  if (process.env['GEMINI_CLI_NO_RELAUNCH']) {
    return [];
  }

  if (targetMaxOldSpaceSizeInMB > currentMaxOldSpaceSizeMb) {
    if (config.getDebugMode()) {
      console.debug(
        `Need to relaunch with more memory: ${targetMaxOldSpaceSizeInMB.toFixed(2)} MB`,
      );
    }
    return [`--max-old-space-size=${targetMaxOldSpaceSizeInMB}`];
  }

  return [];
}

async function relaunchWithAdditionalArgs(additionalArgs: string[]) {
  const nodeArgs = [...additionalArgs, ...process.argv.slice(1)];
  const newEnv = { ...process.env, GEMINI_CLI_NO_RELAUNCH: 'true' };

  const child = spawn(process.execPath, nodeArgs, {
    stdio: 'inherit',
    env: newEnv,
  });

  await new Promise((resolve) => child.on('close', resolve));
  process.exit(0);
}

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
  workspaceRoot: string,
) {
  const version = await getCliVersion();
  // Detect and enable Kitty keyboard protocol once at startup
  await detectAndEnableKittyProtocol();
  setWindowTitle(basename(workspaceRoot), settings);
  const instance = render(
    <React.StrictMode>
      <SettingsContext.Provider value={settings}>
        <AppWrapper
          config={config}
          settings={settings}
          startupWarnings={startupWarnings}
          version={version}
        />
      </SettingsContext.Provider>
    </React.StrictMode>,
    { exitOnCtrlC: false, isScreenReaderEnabled: config.getScreenReader() },
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
  const serializer = new QwenStateSerializer();

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

  // Start headless mode (no Ink rendering)
  // We'll track state changes directly instead of rendering to terminal
  // For now, this is a simplified implementation that doesn't run the full UI
  // TODO: Implement proper headless mode that runs App logic without rendering

  console.error('[ServerMode] Server mode is running...');
  console.error(
    '[ServerMode] NOTE: This is a preliminary implementation.',
  );
  console.error(
    '[ServerMode] Full integration with App state requires additional work.',
  );

  // MOCK TEST MODE: Send realistic mock responses for testing C++ side
  while (server.isRunning()) {
    const cmd = await server.receiveCommand();
    if (cmd) {
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
          message: 'Processing your request...',
        });

        await new Promise((resolve) => setTimeout(resolve, 300));

        // Simulate streaming AI response in chunks
        const mockResponse = `I understand you said "${cmd.content}". This is a mock response from the test server mode. I can help you with various tasks!`;
        const words = mockResponse.split(' ');

        for (let i = 0; i < words.length; i += 3) {
          const chunk = words.slice(i, i + 3).join(' ') + ' ';
          await server.sendMessage({
            type: 'conversation',
            role: 'assistant',
            content: chunk,
            id: Date.now() + i,
            isStreaming: true,
          });
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        // Final complete message
        await server.sendMessage({
          type: 'conversation',
          role: 'assistant',
          content: '',
          id: Date.now() + 1000,
          isStreaming: false,
        });

        // Simulate a tool call if the message contains "test tool"
        if (cmd.content.toLowerCase().includes('test tool')) {
          await new Promise((resolve) => setTimeout(resolve, 200));

          await server.sendMessage({
            type: 'tool_group',
            id: Date.now(),
            tools: [
              {
                id: 'tool_1',
                name: 'read_file',
                arguments: { path: '/example/test.txt' },
                status: 'pending',
                needsConfirmation: true,
                confirmationDetails: 'Read the test file to analyze its contents',
              },
            ],
          });
        }

        // Send completion stats
        await server.sendMessage({
          type: 'completion_stats',
          inputTokens: 150,
          outputTokens: 50,
          totalTokens: 200,
        });

      } else if (cmd.type === 'tool_approval') {
        console.error('[ServerMode] Tool approval received:', cmd);

        if (cmd.approved) {
          // Simulate tool execution
          await server.sendMessage({
            type: 'status',
            message: 'Executing tool...',
          });

          await new Promise((resolve) => setTimeout(resolve, 500));

          await server.sendMessage({
            type: 'info',
            message: 'Tool execution complete: Read 150 lines from test.txt',
          });

          await server.sendMessage({
            type: 'conversation',
            role: 'assistant',
            content: 'Tool executed successfully! The file contains example data.',
            id: Date.now(),
          });
        } else {
          await server.sendMessage({
            type: 'info',
            message: 'Tool execution cancelled by user',
          });
        }
      } else if (cmd.type === 'interrupt') {
        console.error('[ServerMode] Interrupt received, shutting down');
        break;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  await server.stop();
  console.error('[ServerMode] Server mode stopped');
}

export async function main() {
  setupUnhandledRejectionHandler();
  const workspaceRoot = process.cwd();
  const settings = loadSettings(workspaceRoot);

  await cleanupCheckpoints();
  if (settings.errors.length > 0) {
    const errorMessages = settings.errors.map(
      (error) => `Error in ${error.path}: ${error.message}`,
    );
    throw new FatalConfigError(
      `${errorMessages.join('\n')}\nPlease fix the configuration file(s) and try again.`,
    );
  }

  const argv = await parseArguments(settings.merged);
  const extensions = loadExtensions(workspaceRoot);
  const config = await loadCliConfig(
    settings.merged,
    extensions,
    sessionId,
    argv,
  );

  const consolePatcher = new ConsolePatcher({
    stderr: true,
    debugMode: config.getDebugMode(),
  });
  consolePatcher.patch();
  registerCleanup(consolePatcher.cleanup);

  dns.setDefaultResultOrder(
    validateDnsResolutionOrder(settings.merged.advanced?.dnsResolutionOrder),
  );

  if (argv.promptInteractive && !process.stdin.isTTY) {
    console.error(
      'Error: The --prompt-interactive flag is not supported when piping input from stdin.',
    );
    process.exit(1);
  }

  if (config.getListExtensions()) {
    console.log('Installed extensions:');
    for (const extension of extensions) {
      console.log(`- ${extension.config.name}`);
    }
    process.exit(0);
  }

  // Set a default auth type if one isn't set.
  if (!settings.merged.security?.auth?.selectedType) {
    if (process.env['CLOUD_SHELL'] === 'true') {
      settings.setValue(
        SettingScope.User,
        'selectedAuthType',
        AuthType.CLOUD_SHELL,
      );
    }
  }
  // Empty key causes issues with the GoogleGenAI package.
  if (process.env['GEMINI_API_KEY']?.trim() === '') {
    delete process.env['GEMINI_API_KEY'];
  }

  if (process.env['GOOGLE_API_KEY']?.trim() === '') {
    delete process.env['GOOGLE_API_KEY'];
  }

  setMaxSizedBoxDebugging(config.getDebugMode());

  await config.initialize();

  if (config.getIdeMode()) {
    await config.getIdeClient().connect();
    logIdeConnection(config, new IdeConnectionEvent(IdeConnectionType.START));
  }

  // Load custom themes from settings
  themeManager.loadCustomThemes(settings.merged.ui?.customThemes);

  if (settings.merged.ui?.theme) {
    if (!themeManager.setActiveTheme(settings.merged.ui?.theme)) {
      // If the theme is not found during initial load, log a warning and continue.
      // The useThemeCommand hook in App.tsx will handle opening the dialog.
      console.warn(`Warning: Theme "${settings.merged.ui?.theme}" not found.`);
    }
  }

  // hop into sandbox if we are outside and sandboxing is enabled
  if (!process.env['SANDBOX']) {
    const memoryArgs = settings.merged.advanced?.autoConfigureMemory
      ? getNodeMemoryArgs(config)
      : [];
    const sandboxConfig = config.getSandbox();
    if (sandboxConfig) {
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
          await config.refreshAuth(settings.merged.security.auth.selectedType);
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

      await start_sandbox(sandboxConfig, memoryArgs, config, sandboxArgs);
      process.exit(0);
    } else {
      // Not in a sandbox and not entering one, so relaunch with additional
      // arguments to control memory usage if needed.
      if (memoryArgs.length > 0) {
        await relaunchWithAdditionalArgs(memoryArgs);
        process.exit(0);
      }
    }
  }

  if (
    settings.merged.security?.auth?.selectedType ===
      AuthType.LOGIN_WITH_GOOGLE &&
    config.isBrowserLaunchSuppressed()
  ) {
    // Do oauth before app renders to make copying the link possible.
    await getOauthClient(settings.merged.security.auth.selectedType, config);
  }

  // Check for server mode
  if (argv.serverMode) {
    const server = createStructuredServer({
      mode: argv.serverMode as 'stdin' | 'pipe' | 'tcp',
      pipePath: argv.pipePath,
      tcpPort: argv.tcpPort,
    });

    await server.start();

    const startupWarnings = [
      ...(await getStartupWarnings()),
      ...(await getUserStartupWarnings(workspaceRoot)),
    ];

    return runServerMode(config, settings, startupWarnings, workspaceRoot, server);
  }

  if (config.getExperimentalZedIntegration()) {
    return runZedIntegration(config, settings, extensions, argv);
  }

  let input = config.getQuestion();
  const startupWarnings = [
    ...(await getStartupWarnings()),
    ...(await getUserStartupWarnings(workspaceRoot)),
  ];

  // Render UI, passing necessary config values. Check that there is no command line question.
  if (config.isInteractive()) {
    await startInteractiveUI(config, settings, startupWarnings, workspaceRoot);
    return;
  }
  // If not a TTY, read from stdin
  // This is for cases where the user pipes input directly into the command
  if (!process.stdin.isTTY) {
    const stdinData = await readStdin();
    if (stdinData) {
      input = `${stdinData}\n\n${input}`;
    }
  }
  if (!input) {
    console.error(
      `No input provided via stdin. Input can be provided by piping data into gemini or using the --prompt option.`,
    );
    process.exit(1);
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
  );

  if (config.getDebugMode()) {
    console.log('Session ID: %s', sessionId);
  }

  await runNonInteractive(nonInteractiveConfig, input, prompt_id);
  process.exit(0);
}

function setWindowTitle(title: string, settings: LoadedSettings) {
  if (!settings.merged.ui?.hideWindowTitle) {
    const windowTitle = (process.env['CLI_TITLE'] || `Qwen - ${title}`).replace(
      // eslint-disable-next-line no-control-regex
      /[\x00-\x1F\x7F]/g,
      '',
    );
    process.stdout.write(`\x1b]2;${windowTitle}\x07`);

    process.on('exit', () => {
      process.stdout.write(`\x1b]2;\x07`);
    });
  }
}

/**
 * NanoClaw Agent Runner (Kimi Agent SDK)
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per turn).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { createSession, type StreamEvent } from '@moonshot-ai/kimi-agent-sdk';
import { fileURLToPath } from 'url';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  secrets?: Record<string, string>;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;
const KIMI_CONFIG_DIR = '/home/node/.kimi';

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

/**
 * Write Kimi config.toml with provider, model, and API key.
 * By writing to config file instead of env var, Bash subprocesses can't access the key.
 */
function writeKimiConfig(apiKey: string): void {
  fs.mkdirSync(KIMI_CONFIG_DIR, { recursive: true });
  const config = `default_model = "k25"

[providers.moonshot]
type = "kimi"
base_url = "https://api.moonshot.ai/v1"
api_key = "${apiKey}"

[models.k25]
provider = "moonshot"
model = "kimi-k2.5"
max_context_size = 262144
`;
  fs.writeFileSync(path.join(KIMI_CONFIG_DIR, 'config.toml'), config);
}

/**
 * Write MCP server configuration for Kimi CLI.
 */
function writeMcpConfig(containerInput: ContainerInput, mcpServerPath: string): void {
  const config = {
    mcpServers: {
      nanoclaw: {
        command: 'node',
        args: [mcpServerPath],
        env: {
          NANOCLAW_CHAT_JID: containerInput.chatJid,
          NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
          NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
        },
      },
    },
  };
  fs.writeFileSync(
    path.join(KIMI_CONFIG_DIR, 'mcp.json'),
    JSON.stringify(config, null, 2)
  );
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Run a single turn with the Kimi session and stream results.
 */
async function runTurn(
  session: ReturnType<typeof createSession>,
  prompt: string,
): Promise<{ result: string | null; status: string }> {
  let resultText: string | null = null;
  let eventCount = 0;

  const turn = session.prompt(prompt);

  for await (const event of turn) {
    eventCount++;
    log(`[event #${eventCount}] type=${event.type}`);

    if (event.type === 'ContentPart') {
      const payload = event.payload as { type?: string; text?: string };
      if (payload.type === 'text' && payload.text) {
        resultText = (resultText || '') + payload.text;
      }
    } else if (event.type === 'ToolCall') {
      const payload = event.payload as { name?: string };
      log(`Tool call: ${payload.name || 'unknown'}`);
    } else if (event.type === 'ToolResult') {
      log('Tool result received');
    } else if (event.type === 'CompactionBegin') {
      log('Context compaction starting');
    } else if (event.type === 'CompactionEnd') {
      log('Context compaction complete');
    } else if (event.type === 'SubagentEvent') {
      const payload = event.payload as { task_tool_call_id?: string };
      log(`Subagent event: ${payload.task_tool_call_id || 'unknown'}`);
    }
  }

  const runResult = await turn.result;
  log(`Turn done. Events: ${eventCount}, status: ${runResult.status}, hasResult: ${!!resultText}`);
  return { result: resultText, status: runResult.status };
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    // Delete the temp file the entrypoint wrote — it contains secrets
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  // Get API key from secrets
  const apiKey = containerInput.secrets?.KIMI_API_KEY;
  if (apiKey) {
    writeKimiConfig(apiKey);
    log('Kimi config.toml written');
  } else {
    log('WARNING: No KIMI_API_KEY found in secrets');
  }

  // Remove secrets from env to prevent leakage to subprocesses
  delete process.env.KIMI_API_KEY;

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  // Write MCP config for Kimi CLI
  writeMcpConfig(containerInput, mcpServerPath);
  log('MCP config written');

  const sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Load global CLAUDE.md as additional context for non-main groups
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalContext = '';
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalContext = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Build initial prompt
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Prepend global context to first prompt if available
  if (globalContext) {
    prompt = `<global-context>\n${globalContext}\n</global-context>\n\n${prompt}`;
  }

  // Create Kimi session (model defaults to "k25" from config.toml)
  const session = createSession({
    workDir: '/workspace/group',
    sessionId,
    model: 'k25',
    yoloMode: true,
  });

  log(`Session created: ${session.sessionId}`);

  // Query loop: run turn → wait for IPC message → run new turn → repeat
  try {
    while (true) {
      log(`Starting turn (session: ${session.sessionId})...`);

      const turnResult = await runTurn(session, prompt);

      writeOutput({
        status: 'success',
        result: turnResult.result,
        newSessionId: session.sessionId,
      });

      // Check if close sentinel appeared during the turn
      if (shouldClose()) {
        log('Close sentinel detected after turn, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: session.sessionId });

      log('Turn ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new turn`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: session.sessionId,
      error: errorMessage
    });
    process.exit(1);
  } finally {
    try { await session.close(); } catch { /* ignore */ }
  }
}

main();

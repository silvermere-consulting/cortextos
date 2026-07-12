import { join } from 'path';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { platform } from 'os';
import type { AgentConfig, CtxEnv } from '../types/index.js';
import { OutputBuffer } from './output-buffer.js';

// node-pty types
interface IPty {
  pid: number;
  write(data: string): void;
  onData(callback: (data: string) => void): { dispose(): void };
  onExit(callback: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  kill(signal?: string): void;
  resize(cols: number, rows: number): void;
}

interface IPtySpawnOptions {
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
}

type SpawnFn = (file: string, args: string[], options: IPtySpawnOptions) => IPty;

/**
 * Environment variables an agent must NEVER receive, from ANY source (org secrets.env,
 * agent .env, or the daemon's process env). Cherry-picked onto main 2026-07-12 as the DENY
 * portion of the env chokepoint — the full allow-list keep-set is unsettled and is NOT shipped
 * here. WHY: Claude Code PREFERS an ANTHROPIC_API_KEY over the claude.ai subscription whenever
 * one is present, so forwarding it makes every agent bill per-token and a key revocation
 * fleet-fatal — a P1 violation (all model calls go through the ai-gateway). The key STAYS in
 * secrets.env (the gateway needs it); it must simply never reach an agent. DO NOT REMOVE.
 */
const AGENT_ENV_DENY = new Set([
  'ANTHROPIC_API_KEY',
  'CLAUDE_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'MISTRAL_API_KEY',
  'COHERE_API_KEY',
  'GROQ_API_KEY',
  'XAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'PERPLEXITY_API_KEY',
  'TOGETHER_API_KEY',
  'FIREWORKS_API_KEY',
  'REPLICATE_API_TOKEN',
  'HUGGINGFACE_API_KEY',
  'AZURE_OPENAI_API_KEY',
]);

// Net for a provider key we have not enumerated yet — denied on arrival, not on the next
// incident. Enumerating names alone is how GEMINI_API_KEY once sailed through; the pattern
// closes the provider-key CLASS so a new provider is denied before it is added by name.
const PROVIDER_KEY_RE =
  /^(ANTHROPIC|CLAUDE|OPENAI|GEMINI|GOOGLE_?(AI|GENAI)?|VERTEX|MISTRAL|COHERE|GROQ|XAI|DEEPSEEK|PERPLEXITY|TOGETHER|FIREWORKS|REPLICATE|HUGGINGFACE|HF|AZURE_OPENAI|BEDROCK|OLLAMA|AI21|STABILITY)[A-Z0-9_]*_(API_)?(KEY|TOKEN|SECRET)$/;

/** True when this env var must never reach an agent process. Applied at EVERY env door. */
function isDeniedAgentEnv(name: string): boolean {
  return AGENT_ENV_DENY.has(name) || PROVIDER_KEY_RE.test(name);
}

/**
 * Manages a single Claude Code PTY session.
 * Replaces the tmux session management in agent-wrapper.sh.
 */
export class AgentPTY {
  private pty: IPty | null = null;
  // Retained reference to the underlying node-pty handle so forceKill() can
  // SIGKILL-escalate AFTER kill() has optimistically nulled `this.pty`. Without
  // this, a graceful kill() throws the handle away and a child that holds the
  // graceful signal pending (T-state / SIG_IGN) leaks as an orphan because we
  // can no longer reach it. Cleared only when the real onExit fires.
  private rawPty: IPty | null = null;
  private _alive = false;
  private outputBuffer: OutputBuffer;
  private env: CtxEnv;
  private config: AgentConfig;
  private onExitHandler: ((exitCode: number, signal?: number) => void) | null = null;
  private spawnFn: SpawnFn | null = null;

  constructor(env: CtxEnv, config: AgentConfig, logPath?: string, bootstrapPattern?: string) {
    this.env = env;
    this.config = config;
    this.outputBuffer = new OutputBuffer(1000, logPath, bootstrapPattern);
  }

  /**
   * Spawn Claude Code in a PTY process.
   *
   * @param mode 'fresh' for new conversation, 'continue' for preserving history
   * @param prompt The startup or continue prompt to pass to Claude
   */
  async spawn(mode: 'fresh' | 'continue', prompt: string): Promise<void> {
    if (this.pty) {
      throw new Error('PTY already spawned. Kill first.');
    }

    // Lazy-load node-pty (native addon)
    if (!this.spawnFn) {
      const nodePty = require('node-pty');
      this.spawnFn = nodePty.spawn;
    }

    const cwd = this.config.working_directory || this.env.agentDir || process.cwd();

    // Build environment variables for the PTY process
    const ptyEnv: Record<string, string> = {
      ...this.getBaseEnv(),
      CTX_INSTANCE_ID: this.env.instanceId,
      CTX_ROOT: this.env.ctxRoot,
      CTX_FRAMEWORK_ROOT: this.env.frameworkRoot,
      CTX_AGENT_NAME: this.env.agentName,
      CTX_ORG: this.env.org,
      CTX_AGENT_DIR: this.env.agentDir,
      CTX_PROJECT_ROOT: this.env.projectRoot,
      // Backward compat
      CRM_AGENT_NAME: this.env.agentName,
      CRM_TEMPLATE_ROOT: this.env.frameworkRoot,
    };

    // Source org-level shared secrets (orgs/{org}/secrets.env).
    // These are shared across all agents in the org: OPENAI_KEY, APIFY_TOKEN, GEMINI_API_KEY, etc.
    // Agent .env is loaded after and overrides org values — agent-specific keys win.
    if (this.env.org && this.env.projectRoot) {
      const orgEnvFile = join(this.env.projectRoot, 'orgs', this.env.org, 'secrets.env');
      if (existsSync(orgEnvFile)) {
        const content = readFileSync(orgEnvFile, 'utf-8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx > 0) {
            const k = trimmed.slice(0, eqIdx).trim();
            if (isDeniedAgentEnv(k)) continue;  // never forward a model-provider key to an agent (P1)
            ptyEnv[k] = trimmed.slice(eqIdx + 1).trim();
          }
        }
      }
    }

    // Source agent .env file (overrides org secrets.env for same key names).
    // Contains agent-specific secrets: BOT_TOKEN, CHAT_ID, CLAUDE_CODE_OAUTH_TOKEN.
    const agentEnvFile = join(this.env.agentDir, '.env');
    if (existsSync(agentEnvFile)) {
      const content = readFileSync(agentEnvFile, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          const k = trimmed.slice(0, eqIdx).trim();
          if (isDeniedAgentEnv(k)) continue;  // never forward a model-provider key to an agent (P1)
          ptyEnv[k] = trimmed.slice(eqIdx + 1).trim();
        }
      }
    }

    // Add convenience CTX_* aliases used throughout agent templates.
    // CTX_TELEGRAM_CHAT_ID: alias for CHAT_ID from the agent's .env
    if (ptyEnv['CHAT_ID']) {
      ptyEnv['CTX_TELEGRAM_CHAT_ID'] = ptyEnv['CHAT_ID'];
    }
    // CTX_TIMEZONE: from config.json timezone field, falls back to system TZ
    const configTimezone = this.config.timezone;
    if (configTimezone) {
      ptyEnv['CTX_TIMEZONE'] = configTimezone;
      ptyEnv['TZ'] = configTimezone; // also set TZ so date/time system calls use correct zone
    } else if (process.env.TZ) {
      ptyEnv['CTX_TIMEZONE'] = process.env.TZ;
    }
    // CTX_ORCHESTRATOR_AGENT: read from org context.json so agents can route to orchestrator
    if (this.env.projectRoot && this.env.org) {
      try {
        const contextPath = join(this.env.projectRoot, 'orgs', this.env.org, 'context.json');
        if (existsSync(contextPath)) {
          const ctx = JSON.parse(readFileSync(contextPath, 'utf-8'));
          if (ctx.orchestrator) {
            ptyEnv['CTX_ORCHESTRATOR_AGENT'] = ctx.orchestrator;
          }
        }
      } catch { /* leave unset if context.json is missing or malformed */ }
    }

    // Spawn the agent binary directly (no shell wrapper) — cross-platform, no shell escaping needed.
    // env is passed natively via node-pty options; no bash export commands required.
    // On Windows, npm global installs create .cmd wrappers, not .exe binaries.
    // node-pty's CreateProcess requires the exact wrapper name to resolve correctly.
    const claudeArgs = this.buildClaudeArgs(mode, prompt);
    const claudeCmd = this.getBinaryName();

    this.pty = this.spawnFn!(claudeCmd, claudeArgs, {
      name: 'xterm-256color',
      cols: 200,
      rows: 50,
      cwd,
      env: ptyEnv,
    });

    this.rawPty = this.pty;
    this._alive = true;

    // Track whether we've already accepted the bypass-permissions prompt so we
    // don't send the key sequence multiple times.
    let bypassAccepted = false;

    // Detect the bypass-permissions warning across known wording variants
    // (audit 2026-05-22 row #4 — engineer hung ~10min after a model-change
    // restart because the prompt rendered late/with different text and the
    // old detector missed it).
    const detectsBypassPrompt = (buffer: string): boolean => {
      const cleaned = buffer.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
      return /No,?\s*exit/i.test(cleaned) ||
             /Yes,?\s*I\s*accept/i.test(cleaned) ||
             /Bypass\s*Permissions/i.test(cleaned);
    };

    // Set up output capture
    this.pty.onData((data: string) => {
      this.outputBuffer.push(data);

      // Auto-accept the "Bypass Permissions mode" warning immediately when it appears.
      // The prompt defaults to option 1 "No, exit" — we must press Down then Enter
      // to reach option 2 "Yes, I accept". Using onData (not setTimeout) because
      // the agent exits in under 2s if nothing responds.
      if (!bypassAccepted && this.pty && detectsBypassPrompt(data)) {
        bypassAccepted = true;
        // Small delay so the PTY finishes rendering before we send input
        setTimeout(() => { this.pty?.write('\x1b[B\r'); }, 100);
      }
    });

    // Set up exit handler
    this.pty.onExit(({ exitCode, signal }) => {
      this._alive = false;
      this.pty = null;
      this.rawPty = null;
      if (this.onExitHandler) {
        this.onExitHandler(exitCode, signal);
      }
    });

    // Claude Code shows a "trust this folder?" prompt on first run in a new directory.
    // Auto-accept by sending Enter after the prompt appears.
    //
    // Claude Code also shows a "Bypass Permissions mode" warning on first run with
    // --dangerously-skip-permissions. That prompt defaults to option 1 "No, exit",
    // so we must press Down (\x1b[B) to reach option 2 "Yes, I accept" before Enter.
    //
    // Audit 2026-05-22 row #4: model-change restart tripped this halt because the
    // old 2s/5s/8s schedule fired before the prompt rendered (first-use of a new
    // model adds latency). Retry schedule widened to cover ~60s; detection
    // updated to match any of {No, exit / Yes, I accept / Bypass Permissions}.
    const acceptPrompt = () => {
      if (!this.pty) return;
      const recent = this.outputBuffer.getRecent();
      const cleaned = recent.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
      if (detectsBypassPrompt(recent)) {
        // Bypass permissions prompt: "No, exit" is option 1 (default highlight).
        // Press Down to move to "Yes, I accept", then Enter to confirm.
        this.pty.write('\x1b[B\r');
      } else if (cleaned.includes('trust') || cleaned.includes('Yes')) {
        this.pty.write('\r');
      }
    };
    for (const ms of [2000, 5000, 8000, 12000, 18000, 25000, 35000, 50000]) {
      setTimeout(acceptPrompt, ms);
    }
  }

  /**
   * Returns the binary name for the agent process.
   * Protected so HermesPTY can override to return 'hermes'.
   */
  protected getBinaryName(): string {
    if (platform() !== 'win32') return 'claude';
    // The Claude Code Windows installer historically shipped a `claude.cmd`
    // shim alongside `claude.exe`. Newer installers (e.g. when claude lives
    // under `~/.local/bin`) ship only `claude.exe` and have no `.cmd` shim.
    // Hardcoding `claude.cmd` causes node-pty/ConPTY to fail with an empty
    // "File not found" error before the agent ever boots.
    //
    // Probe PATH for whichever extension is present and prefer `.exe` —
    // it spawns more cleanly under ConPTY than a `.cmd` wrapper, and matches
    // what `where.exe claude` returns on current installs.
    const pathDirs = (process.env.PATH || '').split(';').filter(Boolean);
    for (const ext of ['.exe', '.cmd']) {
      for (const dir of pathDirs) {
        if (existsSync(join(dir, `claude${ext}`))) {
          return `claude${ext}`;
        }
      }
    }
    // Neither found on PATH — fall back to the legacy default so the error
    // message from node-pty surfaces a recognizable filename for debugging.
    return 'claude.cmd';
  }

  /**
   * Build the claude CLI argument array.
   * Returns args suitable for passing directly to node-pty spawn (no shell escaping needed).
   * Protected so HermesPTY can override this for its own spawn args.
   */
  protected buildClaudeArgs(mode: 'fresh' | 'continue', prompt: string): string[] {
    const args: string[] = [];

    if (mode === 'continue') {
      args.push('--continue');
    }

    args.push('--dangerously-skip-permissions');

    if (this.config.model) {
      args.push('--model', this.config.model);
    }

    // Local override pattern (feat #20): concatenate {agentDir}/local/*.md files
    // and append as system prompt. The local/ dir is gitignored so users can customize
    // agent behavior without merge conflicts on framework updates.
    const agentDir = this.env.agentDir;
    if (agentDir) {
      const localDir = join(agentDir, 'local');
      if (existsSync(localDir)) {
        try {
          const mdFiles = readdirSync(localDir)
            .filter(f => f.endsWith('.md'))
            .sort()
            .map(f => join(localDir, f));
          if (mdFiles.length > 0) {
            const localContent = mdFiles
              .map(f => readFileSync(f, 'utf-8'))
              .join('\n\n');
            args.push('--append-system-prompt', localContent);
          }
        } catch { /* ignore read errors */ }
      }
    }

    // Pass prompt as a plain string — no shell escaping needed when using node-pty directly
    args.push(prompt);

    return args;
  }

  /**
   * Write data to the PTY.
   */
  write(data: string): void {
    if (!this.pty) {
      throw new Error('PTY not spawned');
    }
    this.pty.write(data);
  }

  /**
   * Kill the PTY process.
   */
  kill(): void {
    const pty = this.pty;
    if (pty) {
      this._alive = false;
      this.pty = null;
      // NOTE: this.rawPty is intentionally NOT cleared here — it is retained so
      // forceKill() can SIGKILL-escalate if this graceful kill does not produce
      // an exit. It is cleared by the onExit handler when the process actually
      // dies (by any means).
      try {
        pty.kill();
      } catch {
        // PTY may have exited between the isAlive() check and here — ignore.
      }
    }
  }

  /**
   * Force-terminate the underlying process with SIGKILL.
   *
   * Used by AgentProcess.stop() as an escalation when the graceful kill() did
   * not produce an exit within the timeout — e.g. a child that is STOPped
   * (T-state, from a SIGSTOP) or ignoring/blocking the graceful signal holds
   * SIGTERM/SIGHUP pending, so the PTY would otherwise leak as a daemon orphan.
   * SIGKILL cannot be caught, blocked, or ignored, and is delivered even to
   * stopped processes, so recovery never leaks an unkillable PTY.
   *
   * Operates on the retained rawPty handle (kill() nulls this.pty). Safe to call
   * after kill() and idempotent: a no-op once the process has already exited
   * (onExit clears rawPty).
   */
  forceKill(): void {
    const pty = this.rawPty;
    if (pty) {
      try {
        pty.kill('SIGKILL');
      } catch {
        // Process already gone — ignore.
      }
    }
  }

  /**
   * Check if the PTY process is alive.
   * Uses an internal flag set by the onExit handler — cross-platform safe.
   * (process.kill(pid, 0) is unreliable on Windows.)
   */
  isAlive(): boolean {
    return this._alive && this.pty !== null;
  }

  /**
   * Get the PTY PID.
   */
  getPid(): number | null {
    return this.pty?.pid || null;
  }

  /**
   * Register an exit handler.
   */
  onExit(handler: (exitCode: number, signal?: number) => void): void {
    this.onExitHandler = handler;
  }

  /**
   * Get the output buffer for inspection.
   */
  getOutputBuffer(): OutputBuffer {
    return this.outputBuffer;
  }

  /**
   * Get a clean base environment (excluding potentially harmful vars).
   */
  private getBaseEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    // Copy essential env vars
    const keepVars = [
      'PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL',
      'TMPDIR', 'TEMP', 'TMP',
      // ANTHROPIC_API_KEY / CLAUDE_API_KEY DELIBERATELY REMOVED 2026-07-12 — a provider key
      // must never reach an agent (see AGENT_ENV_DENY). isDeniedAgentEnv also strips them from
      // the secrets.env + agent .env loops above, so this is one of THREE doors, all closed.
      'NODE_PATH', 'COMSPEC', 'USERPROFILE',
      // Windows path-expansion essentials. Stripping these causes phantom
      // %SystemDrive% directories from inherited Search Indexer processes
      // and Unity batchmode UPM IPC crashes (path.join(undefined,...)).
      'SystemDrive', 'SystemRoot', 'windir',
      'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ALLUSERSPROFILE',
      'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
      'HOMEDRIVE', 'HOMEPATH', 'PUBLIC',
    ];
    for (const key of keepVars) {
      if (process.env[key]) {
        env[key] = process.env[key]!;
      }
    }

    // Windows: ensure UTF-8 locale so emoji and Unicode pass through the PTY
    if (platform() === 'win32') {
      if (!env['LANG']) env['LANG'] = 'en_US.UTF-8';
      if (!env['LC_ALL']) env['LC_ALL'] = 'en_US.UTF-8';
      if (!process.env['PYTHONIOENCODING']) env['PYTHONIOENCODING'] = 'utf-8';
    }

    return env;
  }
}

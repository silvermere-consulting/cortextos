import { Command } from 'commander';
import { IPCClient } from '../daemon/ipc-server.js';
import { writeStopMarker } from './stop.js';

export const restartCommand = new Command('restart')
  .argument('<agent>', 'Agent name to restart')
  .option('--instance <id>', 'Instance ID', 'default')
  .description('Restart a running agent (stop + start). Re-reads config.json and .env, respawns the PTY. Does NOT restart the daemon process itself — use `pm2 restart cortextos-daemon` for that.')
  .action(async (agent: string, options: { instance: string }) => {
    const ipc = new IPCClient(options.instance);
    const daemonRunning = await ipc.isDaemonRunning();

    if (!daemonRunning) {
      console.error('Daemon is not running. Start it first: cortextos start');
      process.exit(1);
    }

    console.log(`Restarting agent: ${agent}`);

    // Write the .user-stop marker BEFORE the IPC so the SessionEnd crash-alert
    // hook does not fire a false 🚨 CRASH alarm during the brief stop window.
    // (BUG-036 pattern.)
    writeStopMarker(options.instance, agent, 'stopped via cortextos restart');

    // Use restart-agent IPC (single message → daemon chains stopAgent →
    // await → startAgent internally). Avoids the race where two parallel
    // IPC calls (stop-agent then start-agent) hit agent-manager faster
    // than the stop completes, producing:
    //   [agent-manager] Agent X is already stopping — ignoring concurrent
    //   IPC start-agent
    // and leaving the agent STOPPED without respawn. Matches the same
    // pattern used by self-restart / hard-restart / soft-restart.
    const response = await ipc.send({ type: 'restart-agent', agent, source: 'cortextos restart' });
    if (!response.success) {
      console.error(`  Restart failed: ${response.error}`);
      console.error(`  If the agent is now stopped, recover with: cortextos start ${agent}`);
      process.exit(1);
    }
    console.log(`  ${response.data}`);
  });

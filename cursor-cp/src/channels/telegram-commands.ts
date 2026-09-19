export interface BotCommandSpec {
  command: string;
  description: string;
}

/** Slash commands registered for allowlisted users (Telegram autocomplete). */
export function listTelegramBotCommands(): BotCommandSpec[] {
  return [
    { command: 'start', description: 'Show help' },
    { command: 'sessions', description: 'List sessions and connect' },
    { command: 'models', description: 'List models and set default' },
    { command: 'current', description: 'Show current session' },
    { command: 'ask', description: 'Read-only mode (no file edits)' },
    { command: 'agent', description: 'Agent mode (can edit files)' },
    { command: 'plan', description: 'Plan mode (no file writes)' },
    { command: 'close', description: 'Delete current session (asks first)' },
    { command: 'closeall', description: 'Delete all sessions (asks first)' },
    { command: 'repos', description: 'GitHub repos (gh)' },
    { command: 'workspaces', description: 'Local workspace folders' },
    { command: 'progress', description: 'Show in-progress agent step' },
    { command: 'stop', description: 'Cancel the current agent run' },
    { command: 'diff', description: 'Show git diff' },
    { command: 'files', description: 'Files touched this run' },
    { command: 'open', description: 'Open a file from the workspace' },
    { command: 'search', description: 'Search the workspace' },
    { command: 'tree', description: 'Show a shallow directory tree' },
    { command: 'undo', description: 'Revert last agent edits' },
    { command: 'status', description: 'git status' },
    { command: 'log', description: 'git log' },
    { command: 'branch', description: 'List or switch branches' },
    { command: 'commit', description: 'Commit with confirmation' },
    { command: 'push', description: 'Push with confirmation' },
    { command: 'pr', description: 'Open a GitHub pull request' },
    { command: 'test', description: 'Run project tests' },
    { command: 'lint', description: 'Run lint / typecheck' },
    { command: 'dev', description: 'Start or stop the dev server' },
    { command: 'preview', description: 'Tunnel the running app' },
    { command: 'shot', description: 'Screenshot a page' },
    { command: 'logs', description: 'Show the last command log' },
    { command: 'rules', description: 'Show workspace rules' },
    { command: 'machine', description: 'Home machine and daemon status' },
    { command: 'ui', description: 'Open dashboard URL (Cloudflare tunnel)' },
    { command: 'version', description: 'Show Cursor Control Plane version' },
  ];
}

export function telegramStartHelp(): string {
  return (
    '🤖 *Cursor Control Plane*\n\n' +
    'Available now:\n' +
    '/sessions — List and connect to sessions\n' +
    '/current — Workspace, mode, model, last prompt\n' +
    '/progress — Current run: tool, file, command, elapsed\n' +
    '/stop — Cancel the current run (session stays open)\n' +
    '/diff — Git diff with Keep / Revert per file\n' +
    '/files — Files touched this run\n' +
    '/open <path> — Show a workspace file\n' +
    '/search <query> — Search the repo\n' +
    '/tree [path] — Shallow directory tree\n' +
    '/undo — Restore dirty files (asks first)\n' +
    '/status /log /branch — Git status, log, switch branch\n' +
    '/commit /push /pr — Commit, push, open a PR (asks first)\n' +
    '/test /lint — Run project scripts\n' +
    '/dev /preview /shot /logs — Dev server, app tunnel, screenshot\n' +
    '/ask /agent /plan — Session mode (ask/plan cannot write files)\n' +
    '/rules — Workspace rules · /rules extra <text>\n' +
    '/models — List models and set default\n' +
    '/repos — Browse GitHub repositories\n' +
    '/workspaces — Browse local workspaces\n' +
    '/machine — Daemon, uptime, disk, tunnels · /machine wake\n' +
    '/ui — Dashboard tunnel (token required remotely) · /ui stop when done\n' +
    '/close — Delete current session (asks first)\n' +
    '/closeall — Delete all sessions (asks first)\n' +
    '/version — Show version\n\n' +
    'Switching workspace keeps the old session. /sessions to go back. /close erases history.\n\n' +
    'Send a photo, file, or voice note — caption is the instruction.\n' +
    'Reply to a message to follow up on it. Use @path/to/file to attach a workspace file.\n\n' +
    'Send me any text to start or continue a session.'
  );
}

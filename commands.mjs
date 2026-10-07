// Telegram addresses only the command token, not its arguments.
export function parseTelegramCommand(text, botUsername) {
  const match = /^\/([^\s@]+)(?:@([^\s]+))?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return undefined;
  if (match[2] && match[2].toLowerCase() !== botUsername?.toLowerCase()) {
    return { ignored: true };
  }
  const name = match[1];
  const args = (match[3] || '').trim();
  return { name, args, text: `/${name}${args ? ` ${args}` : ''}` };
}

// Discover at dispatch time: commands added by other extensions need no mapping.
export function findSessionCommand(pi, name) {
  return pi.getCommands().find(command => command.name === name);
}

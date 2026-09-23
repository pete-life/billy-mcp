#!/usr/bin/env node
import {cpSync, existsSync, mkdirSync, readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename, isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

process.umask(0o077);

const {name, version} = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {name: string; version: string};
const usage = `Billy MCP ${version}

Usage:
  billy-mcp                         Start the local MCP stdio server
  billy-mcp setup                   Save a Billy API token through hidden terminal input
  billy-mcp doctor                  Check the local profile and Billy connection (read only)
  billy-mcp recover ID applied|not_applied
                                    Record an operator-verified uncertain outcome
  billy-mcp client-config           Print a generic MCP client configuration example
  billy-mcp skill install --path DIR
  billy-mcp skill install --client codex|claude

The skill command installs into DIR/billy-bookkeeping and refuses an existing target.
It never edits MCP client settings. Use --help to show this message.
`;

function skillInstall(args: string[]) {
  let parent: string | undefined;
  let client: 'codex' | 'claude' | undefined;
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`Expected a value for ${flag || 'skill install'}`);
    if (flag === '--path' && !parent) parent = value;
    else if (flag === '--client' && !client && (value === 'codex' || value === 'claude')) client = value;
    else throw new Error(`Unknown or duplicate skill option: ${flag}`);
  }
  if (!parent && !client) throw new Error('Choose --path DIR or --client codex|claude.');
  if (parent && client) throw new Error('Choose only one of --path or --client.');
  if (parent && !isAbsolute(parent)) throw new Error('--path must be absolute.');
  const skillParent = parent ? resolve(parent) : join(homedir(), client === 'codex' ? '.codex/skills' : '.claude/skills');
  const source = fileURLToPath(new URL('../skills/billy-bookkeeping/', import.meta.url));
  const destination = join(skillParent, basename(source));
  if (!existsSync(join(source, 'SKILL.md'))) throw new Error('Packaged bookkeeping skill is missing. Reinstall the package.');
  if (existsSync(destination)) throw new Error(`Skill already exists at ${destination}. No files changed.`);
  mkdirSync(skillParent, {recursive: true});
  cpSync(source, destination, {recursive: true, force: false, errorOnExist: true});
  process.stdout.write(`Installed bookkeeping skill at ${destination}\n`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) { await import('./launch.js'); return; }
  if (command === '--help' || command === '-h' || command === 'help') { process.stdout.write(usage); return; }
  if (command === 'setup' && args.length === 0) { await import('./setup.js'); return; }
  if (command === 'doctor' && args.length === 0) { await import('./doctor.js'); return; }
  if (command === 'recover') { process.argv.splice(2, 1); await import('./recover.js'); return; }
  if (command === 'client-config' && args.length === 0) {
    process.stdout.write(`${JSON.stringify({mcpServers: {billy: {command: 'npx', args: ['--yes', `${name}@${version}`]}}}, null, 2)}\n`);
    return;
  }
  if (command === 'skill' && args[0] === 'install') { skillInstall(args.slice(1)); return; }
  throw new Error('Unknown command or arguments. Run billy-mcp --help.');
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Billy MCP failed'}\n`);
  process.exitCode = 1;
});

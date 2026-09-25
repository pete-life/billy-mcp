import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

test('published tarball shape and fresh local stdio install work without credentials', async () => {
  const root = mkdtempSync(join(tmpdir(), 'billy-install-'));
  const profile = join(root, 'profile');
  const installed = join(root, 'installed');
  const env = {PATH: process.env.PATH || '', BILLY_DATA_DIR: profile, BILLY_ORGANIZATION_ID: 'fixture-company'};
  try {
    const [packed] = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', root], {encoding: 'utf8'})) as Array<{filename: string; files: Array<{path: string}>}>;
    assert.ok(packed);
    const names = packed.files.map(file => file.path);
    for (const file of ['package.json', 'dist/cli.js', 'dist/launch.js', 'LICENSE', 'README.md', 'docs/installation.md', 'docs/operations.md', 'docs/batches.md', 'docs/live-acceptance.md', 'skills/billy-bookkeeping/references/v02-operations.md', 'skills/billy-bookkeeping/SKILL.md', 'skills/billy-bookkeeping/references/tool-recipes.md', 'skills/billy-bookkeeping/agents/openai.yaml']) {
      assert.ok(names.includes(file), `missing ${file}`);
    }
    assert.ok(names.every(file => !/(^|\/)(src|test|acceptance|receipts|inbox|company-profiles|PBrain)(\/|$)|(^|\/)credentials\.env$|\.sqlite|\.env\.example$/.test(file)), 'tarball contains private or development material');

    execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', installed, join(root, packed.filename)], {encoding: 'utf8'});
    const bin = join(installed, 'node_modules', '.bin', 'billy-mcp');
    const run = (...args: string[]) => spawnSync(bin, args, {env, encoding: 'utf8'});
    const help = run('--help');
    assert.equal(help.status, 0);
    assert.match(help.stdout, /local MCP stdio server/);
    const config = run('client-config');
    assert.equal(config.status, 0);
    assert.deepEqual(JSON.parse(config.stdout).mcpServers.billy.args, ['--yes', `@pete-life/billy-mcp@${JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version}`]);
    assert.ok(!config.stdout.includes('BILLY_ACCESS_TOKEN'));
    const setup = run('setup');
    assert.equal(setup.status, 1);
    assert.match(setup.stderr, /interactive terminal/);
    assert.ok(!existsSync(join(profile, 'credentials.env')));
    const doctor = run('doctor');
    assert.equal(doctor.status, 1);
    assert.match(doctor.stdout, /Missing BILLY_ACCESS_TOKEN/);

    const skillParent = join(root, 'skills');
    const first = run('skill', 'install', '--path', skillParent);
    assert.equal(first.status, 0, first.stderr);
    const installedSkill = join(skillParent, 'billy-bookkeeping');
    assert.match(readFileSync(join(installedSkill, 'SKILL.md'), 'utf8'), /Billy bookkeeping/);
    assert.ok(existsSync(join(installedSkill, 'references', 'tool-recipes.md')));
    const ambiguous = run('skill', 'install', '--path', join(root, 'another'), '--client', 'codex');
    assert.equal(ambiguous.status, 1);
    assert.match(ambiguous.stderr, /only one/);
    assert.ok(!existsSync(join(root, 'another')));
    const second = run('skill', 'install', '--path', skillParent);
    assert.equal(second.status, 1);
    assert.match(second.stderr, /already exists/);

    const client = new Client({name: 'tarball-test', version: '1.0.0'});
    try {
      await client.connect(new StdioClientTransport({command: bin, env, stderr: 'pipe'}));
      const tools = await client.listTools();
      assert.ok(tools.tools.some(tool => tool.name === 'billy_status'));
      const status = await client.callTool({name: 'billy_status', arguments: {}});
      assert.match(JSON.stringify(status), /tokenConfigured/);
      const prompt = await client.getPrompt({name: 'bookkeeping-period', arguments: {start: '2026-09-01', end: '2026-09-22'}});
      assert.match(JSON.stringify(prompt), /skills\/billy-bookkeeping/);
    } finally { await client.close(); }
  } finally { rmSync(root, {recursive: true, force: true}); }
});

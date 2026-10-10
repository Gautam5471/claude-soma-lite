// DEMO ONLY, SANDBOX ONLY. Never point this at a real SOMA_HOME or CLAUDE_CONFIG_DIR.
//
// Print what soma's own pure builders return for a demo lead: the claude argv the spawner would
// launch, the lead's scrubbed environment, and the gh argv soma-pr would run. Nothing is executed.
import { buildLeadArgv, buildLeadEnv } from '/private/tmp/soma-demo/claude-soma-lite/bin/lib/spawn.mjs';
import { buildPrArgs } from '/private/tmp/soma-demo/claude-soma-lite/bin/soma-pr.mjs';

if (process.env.SOMA_HOME !== '/private/tmp/soma-demo/.soma') throw new Error('refusing: not the sandbox');
const id = 'fix-login-bug';
const lead = '/private/tmp/soma-demo/.soma/leads/fix-login-bug';
const argv = buildLeadArgv({
  id,
  sessionUuid: '00000000-0000-4000-8000-000000000001',
  brief: 'Make the username check case-insensitive. Write the failing test first.',
  settingsPath: `${lead}/settings.launch.json`,
  mcpPath: `${lead}/mcp.json`,
  standingPath: `${lead}/standing.md`,
});
console.log('ARGV', JSON.stringify(argv));
const env = buildLeadEnv({ id, sessionUuid: '00000000-0000-4000-8000-000000000001', teammateEffort: 'inherit' });
console.log('ENV', JSON.stringify(env));
console.log('PR', JSON.stringify(buildPrArgs(['--title', 'Fix login for capitalised usernames', '-fd=false', '--draft=false'])));

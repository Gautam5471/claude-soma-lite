// DEMO ONLY, SANDBOX ONLY. Never point this at a real SOMA_HOME or CLAUDE_CONFIG_DIR.
//
// Cut one git worktree per task with soma's own worktree.mjs, and write each worktree's
// guard file with soma's own settings-gen.mjs — the spawner's pre-launch steps, nothing launched.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureWorktree } from '/private/tmp/soma-demo/claude-soma-lite/bin/lib/worktree.mjs';
import { writeWorktreeGuardrails } from '/private/tmp/soma-demo/claude-soma-lite/bin/lib/settings-gen.mjs';

if (process.env.SOMA_HOME !== '/private/tmp/soma-demo/.soma' || process.env.HOME !== '/private/tmp/soma-demo') {
  throw new Error('refusing: not the sandbox');
}
const repoPath = '/private/tmp/soma-demo/repos/demo-app';
const out = [];
for (const taskId of ['fix-login-bug', 'add-rate-limit', 'docs-quickstart']) {
  const wt = ensureWorktree({ repo: 'demo-app', taskId, base: 'main', repoPath });
  writeWorktreeGuardrails(wt.dir, { teammateAllow: [] });
  out.push({ taskId, dir: wt.dir, branch: wt.branch, base_sha: wt.base_sha, reused: wt.reused, excluded: wt.excluded });
}
console.log(JSON.stringify(out, null, 2));
const guard = JSON.parse(readFileSync(join(out[0].dir, '.claude', 'settings.local.json'), 'utf8'));
console.log(JSON.stringify(guard, null, 2));

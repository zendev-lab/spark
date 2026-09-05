import type { Task } from "./suite.mts";

/** Adapters return observations. Expected values and verdicts never enter this process. */
export function workerSource(task: Task, modulePath: string): string {
  const target = JSON.stringify(modulePath);
  const bodies: Record<string, string> = {
    "pr-checks": `
import { runGitHubPrChecks } from ${target};
async function evaluate(input) {
  const runner = async (command, args) => {
    const ok = (value) => ({code:0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr:''});
    if (command === 'git' && args[0] === 'rev-parse') return ok(input.head ?? 'head-1');
    if (command === 'git' && args[0] === 'status') return ok(input.dirty ? ' M file.ts' : '');
    if (command === 'gh' && args[1] === 'view') return ok({number:17, headRefOid:input.remoteHead ?? 'head-1', state:input.state ?? 'OPEN', isDraft:false});
    if (command === 'gh' && args[1] === 'checks') return ok(args.includes('--required') ? input.required ?? [] : input.recorded ?? []);
    throw new Error('Unexpected command');
  };
  const report = await runGitHubPrChecks('/workspace', undefined, runner);
  return {verdict:report.verdict, checks:report.checks.length};
}`,
    "ask-partial": `
import { normalizeSparkAskFlowResult } from ${target};
function evaluate(input) {
  const result = normalizeSparkAskFlowResult(input.result, input.request);
  return {status:result.status, nextAction:result.nextAction, answers:result.answers};
}`,
    "cross-realm": `
import { runInNewContext } from 'node:vm';
import { isRoleNativeExecutorCompatibilityError } from ${target};
function evaluate(input) {
  let error;
  switch(input.kind) {
    case 'local-type': error = new TypeError(input.message); break;
    case 'remote-type': error = runInNewContext('new TypeError(message)', {message:input.message}); break;
    case 'remote-error': error = runInNewContext('new Error(message)', {message:input.message}); break;
    case 'object': error = {name:'TypeError', message:input.message}; break;
    case 'throwing-name': error = new TypeError(input.message); Object.defineProperty(error, 'name', {get(){throw new Error('unreadable')}}); break;
    case 'null': error = null; break;
    default: throw new Error('Unknown error fixture');
  }
  return isRoleNativeExecutorCompatibilityError(error);
}`,
    "terminal-width": `
import { ToolCallText } from ${target};
function evaluate(input) { return new ToolCallText(input.text).render(input.width); }
`,
    "sqlite-scope": `
import { join } from 'node:path';
import { openMemorySqliteDatabase, openSqliteDatabase, applyDaemonSqliteResourceLimits } from ${target};
function evaluate(input) {
  const db = input.file ? openSqliteDatabase(join(process.cwd(), 'nested', 'case.sqlite'), input.incremental ? {autoVacuum:'incremental'} : {}) : openMemorySqliteDatabase();
  try {
    if (input.daemon) applyDaemonSqliteResourceLimits(db);
    const read = (pragma) => Object.values(db.prepare('PRAGMA ' + pragma).get())[0];
    return {foreignKeys:read('foreign_keys'), busyTimeout:read('busy_timeout'), cacheSize:read('cache_size'), hardHeapLimit:read('hard_heap_limit'), softHeapLimit:read('soft_heap_limit'), tempStore:read('temp_store'), ...(input.file ? {autoVacuum:read('auto_vacuum')} : {})};
  } finally { db.close(); }
}`,
    "python-request": `
import { resolvePythonRunner } from ${target};
function evaluate(input) {
  const result = resolvePythonRunner(input);
  return {argv:result.argv, ...(result.pythonRequest !== undefined ? {pythonRequest:result.pythonRequest} : {})};
}`,
    "optional-arguments": `
import { normalizeToolCallArguments } from ${target};
function evaluate(input) {
  const args = {...input.args};
  for (const key of input.undefinedKeys ?? []) args[key] = undefined;
  const result = normalizeToolCallArguments(input.parameters, args);
  return {keys:Object.keys(result).sort(), value:JSON.parse(JSON.stringify(result))};
}`,
    "cleanup-cwd": `
import { access, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { GitLifecycleService } from ${target};
import { defaultArtifactStore } from '@zendev-lab/spark-artifacts';
async function evaluate(input) {
  const workspaceRoot = join(process.cwd(), 'workspace');
  const repositoryRoot = join(workspaceRoot, 'repository');
  const worktreeRoot = join(workspaceRoot, 'managed');
  const worktreePath = input.unmanaged ? join(workspaceRoot, 'unmanaged') : join(worktreeRoot, 'acme', 'app', 'cleanup-fixture');
  const daemonCwd = input.related ? worktreePath : join(process.cwd(), 'unrelated-daemon');
  await mkdir(join(repositoryRoot, '.git'), {recursive:true});
  await mkdir(worktreePath, {recursive:true});
  const removals = [];
  const ok = (stdout) => ({stdout, stderr:'', code:0});
  const runner = async (command, args, cwd) => {
    const invocation = command + ' ' + args.join(' ');
    if (invocation === 'git remote get-url origin') return ok('git@github.com:acme/app.git');
    if (invocation === 'git rev-parse --git-common-dir') return ok(join(repositoryRoot, '.git'));
    if (invocation === 'git branch --show-current') return ok('cleanup-fixture');
    if (invocation === 'git status --porcelain') return ok(input.dirty ? ' M dirty.ts' : '');
    if (args[0] === 'rev-list') return ok(input.uncovered ? '1' : '0');
    if (invocation === 'gh stack view --json') return ok(JSON.stringify({trunk:'main', currentBranch:'cleanup-fixture', branches:[{name:'cleanup-fixture', base:'base-oid', isCurrent:true, isMerged:!input.nonterminal}]}));
    if (args[0] === 'pr' && args[1] === 'view') return ok(JSON.stringify({number:123, title:'Cleanup', state:input.nonterminal ? 'OPEN':'MERGED', url:'https://github.com/acme/app/pull/123', body:'', labels:[], headRefName:'cleanup-fixture', baseRefName:'main', isDraft:false, statusCheckRollup:[]}));
    if (args[0] === 'worktree' && args[1] === 'remove') {
      removals.push(cwd);
      if (cwd !== repositoryRoot) return {code:128,stdout:'',stderr:'not a git repository'};
      await rm(worktreePath, {recursive:true}); return ok('');
    }
    return {code:127,stdout:'',stderr:'unexpected command: ' + invocation};
  };
  const store = defaultArtifactStore(workspaceRoot);
  const ref = 'artifact:cleanup-fixture';
  await store.put({ref,kind:'git_change',title:'Cleanup',format:'json',body:{schemaVersion:2,kind:'git_change',repository:{forge:'github',repo:'acme/app',remote:'git@github.com:acme/app.git',commonGitDir:join(repositoryRoot,'.git')},trunk:'main',worktree:{path:worktreePath,branch:'cleanup-fixture',ownership:input.external ? 'external':'spark',status:'attached'},stack:{authority:'gh-stack',currentBranch:'cleanup-fixture',entries:[],observedAt:new Date().toISOString()},lifecycle:'terminal'}});
  const service = new GitLifecycleService({cwd:daemonCwd,workspaceRoot,worktreeRoot,runner,store});
  let status;
  try { const result = await service.cleanup(ref); status = result.body.lifecycle; }
  catch(error) { status = error.code ?? 'error'; }
  const exists = await access(worktreePath).then(()=>true,()=>false);
  return {status,removeCount:removals.length,removalFromRepository:removals.every(cwd=>cwd===repositoryRoot),worktreeExists:exists};
}`,
  };
  const body = bodies[task.id];
  if (!body) throw new Error(`Unknown task adapter: ${task.id}`);
  return `${body}\nimport { readFileSync } from 'node:fs';\nconst input = JSON.parse(readFileSync(0, 'utf8'));\nconst actual = await evaluate(input);\nprocess.stdout.write(JSON.stringify(actual));\n`;
}

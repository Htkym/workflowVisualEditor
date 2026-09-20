export type Group = 'metadata' | 'on' | 'engine' | 'instructions' | 'tools' | 'permissions' | 'safe-outputs' | 'network' | 'imports';
export type Value = string | number | boolean | null | Value[] | { [key: string]: Value };
export const builtInJobs = ['pre_activation', 'pre-activation', 'activation', 'agent', 'detection', 'safe_outputs', 'safe-outputs', 'conclusion'];
export type StepSection = 'steps' | 'pre-steps' | 'setup-steps';
export function jobStepSections(id: string): StepSection[] {
  return !builtInJobs.includes(id) ? ['steps', 'pre-steps', 'setup-steps'] : ['activation', 'pre_activation', 'pre-activation'].includes(id) ? ['pre-steps', 'steps'] : ['pre-steps', 'setup-steps'];
}
export interface Field {
  path: string[]; group: Group; label: [string, string]; kind: 'string' | 'number' | 'boolean' | 'list' | 'schedule' | 'presence' | 'choice';
  options?: string[];
}
const field = (group: Group, path: string, en: string, ja: string, kind: Field['kind'] = 'string', options?: string[]): Field => ({ group, path: path.split('.'), label: [en, ja], kind, options });
// Candidate values from gh-aw v0.89.21 main_workflow_schema.json and ecosystem_domains.json.
// Suggestions do not restrict source values: imported engines and custom destinations remain valid inputs.
const issueEvents = ['opened', 'edited', 'deleted', 'transferred', 'pinned', 'unpinned', 'closed', 'reopened', 'assigned', 'unassigned', 'labeled', 'unlabeled', 'locked', 'unlocked', 'milestoned', 'demilestoned', 'typed', 'untyped', 'field_added', 'field_removed'];
const prEvents = ['assigned', 'unassigned', 'labeled', 'unlabeled', 'opened', 'edited', 'closed', 'reopened', 'synchronize', 'converted_to_draft', 'locked', 'unlocked', 'enqueued', 'dequeued', 'milestoned', 'demilestoned', 'ready_for_review', 'review_requested', 'review_request_removed', 'auto_merge_enabled', 'auto_merge_disabled'];
const toolsets = ['all', 'default', 'action-friendly', 'context', 'repos', 'issues', 'pull_requests', 'actions', 'code_security', 'dependabot', 'discussions', 'experiments', 'gists', 'labels', 'notifications', 'orgs', 'projects', 'search', 'secret_protection', 'security_advisories', 'stargazers', 'users'];
const ecosystems = ['bazel', 'chrome', 'clojure', 'containers', 'copilot-vendor', 'dart', 'defaults', 'deno', 'dev-tools', 'dotnet', 'elixir', 'fonts', 'github', 'github-actions', 'gh-aw', 'go', 'haskell', 'java', 'julia', 'kotlin', 'latex', 'lean', 'linux-distros', 'local', 'lua', 'node', 'node-cdns', 'ocaml', 'perl', 'php', 'playwright', 'powershell', 'python', 'python-native', 'r', 'ruby', 'rust', 'scala', 'swift', 'terraform', 'threat-detection', 'zig'];
export const permissionScopes = ['actions', 'attestations', 'checks', 'code-quality', 'copilot-requests', 'contents', 'deployments', 'discussions', 'drives', 'id-token', 'issues', 'models', 'metadata', 'packages', 'pages', 'pull-requests', 'repository-projects', 'organization-projects', 'organization-custom-org-roles', 'organization-custom-repository-roles', 'security-events', 'secret-scanning-alerts', 'statuses', 'vulnerability-alerts', 'all'];
export const fields: Field[] = [
  field('metadata', 'name', 'Name', '名前'), field('metadata', 'description', 'Description', '説明'),
  field('on', 'on.workflow_dispatch', 'Manual trigger', '手動実行', 'presence'),
  field('on', 'on.issues', 'Issue trigger enabled', 'Issueのトリガーを有効化', 'presence'),
  field('on', 'on.issues.types', 'Issue events (one per line)', 'Issueのイベント種別（1行に1つ）', 'list', issueEvents),
  field('on', 'on.pull_request', 'Pull request trigger enabled', 'PRのトリガーを有効化', 'presence'),
  field('on', 'on.pull_request.types', 'Pull request events (one per line)', 'PRのイベント種別（1行に1つ）', 'list', prEvents),
  field('on', 'on.schedule', 'Cron schedules (one per line)', 'cronスケジュール（1行に1つ）', 'schedule'),
  field('engine', 'engine.id', 'Engine ID', 'Engine ID', 'string', ['copilot', 'claude', 'codex', 'gemini', 'pi']), field('engine', 'engine.model', 'Model', 'モデル'),
  field('tools', 'tools.github', 'GitHub tool enabled', 'GitHubツールを有効化', 'boolean'),
  field('tools', 'tools.github.toolsets', 'GitHub toolsets (one per line)', 'GitHub toolsets（1行に1つ）', 'list', toolsets),
  field('tools', 'tools.github.read-only', 'GitHub read-only', 'GitHubを読み取り専用にする', 'boolean'),
  field('tools', 'tools.bash', 'Allowed bash commands (one per line)', 'bashの許可コマンド（1行に1つ）', 'list'),
  field('tools', 'tools.edit', 'File editing enabled', 'ファイル編集を有効化', 'boolean'),
  ...permissionScopes.map(scope => field('permissions', `permissions.${scope}`, scope, scope, 'choice', ['id-token', 'copilot-requests'].includes(scope) ? ['none', 'write'] : ['models', 'secret-scanning-alerts'].includes(scope) ? ['none', 'read'] : scope === 'all' ? ['read'] : ['none', 'read', 'write'])),
  ...(['add-comment', 'create-issue', 'add-labels', 'create-pull-request'] as const).flatMap(key => [
    field('safe-outputs', `safe-outputs.${key}`, `${key}: enabled`, `${key}を有効化`, 'presence'),
    field('safe-outputs', `safe-outputs.${key}.max`, `${key}: maximum`, `${key}の上限`, 'number')
  ]),
  field('safe-outputs', 'safe-outputs.add-comment.target', 'Comment target', 'コメントの対象', 'string', ['triggering', '*']),
  field('safe-outputs', 'safe-outputs.create-issue.title-prefix', 'Issue title prefix', 'Issueタイトルの接頭辞'),
  field('safe-outputs', 'safe-outputs.create-issue.labels', 'Issue labels (one per line)', 'Issueのラベル（1行に1つ）', 'list'),
  field('safe-outputs', 'safe-outputs.add-labels.allowed', 'Allowed labels (one per line)', '付与を許可するラベル（1行に1つ）', 'list'),
  field('safe-outputs', 'safe-outputs.create-pull-request.title-prefix', 'Pull request title prefix', 'PRタイトルの接頭辞'),
  field('safe-outputs', 'safe-outputs.create-pull-request.draft', 'Create draft pull requests', 'ドラフトPRとして作成', 'boolean'),
  field('network', 'network.allowed', 'Allowed destinations (one per line)', 'ネットワークの許可先（1行に1つ）', 'list', ecosystems),
  field('network', 'timeout-minutes', 'Timeout (minutes)', '制限時間（分）', 'number')
];
export const groups: { id: Group; label: [string, string] }[] = [
  { id: 'metadata', label: ['Workflow', 'Workflow'] }, { id: 'on', label: ['Triggers', 'トリガー'] },
  { id: 'engine', label: ['Engine', 'Engine'] }, { id: 'instructions', label: ['Instructions', '本文'] },
  { id: 'tools', label: ['Tools', 'ツール'] }, { id: 'permissions', label: ['Permissions', '権限'] },
  { id: 'safe-outputs', label: ['Safe Outputs', 'Safe Outputs'] }, { id: 'network', label: ['Network / Limits', 'ネットワーク・制限'] },
  { id: 'imports', label: ['Imports (not expanded)', 'imports（未展開）'] }
];
export function validValue(f: Field, value: unknown): value is Value {
  if (f.kind === 'presence' || f.kind === 'boolean') return typeof value === 'boolean';
  if (f.kind === 'number') return typeof value === 'number' && Number.isSafeInteger(value) && value >= (f.path[0] === 'timeout-minutes' ? 1 : 0) && value <= 2147483647;
  if (f.kind === 'list' || f.kind === 'schedule') return Array.isArray(value) && value.length <= 500 && value.every(x => typeof x === 'string' && x.length > 0 && x.length <= 4096 && !/[\r\n\0]/.test(x));
  return typeof value === 'string' && value.length <= 16384 && !value.includes('\0') && (f.kind !== 'choice' || !!f.options?.includes(value));
}

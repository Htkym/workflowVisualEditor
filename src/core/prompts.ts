// gh-aw inline-sub-agents reference and actions/setup/js/extract_inline_skills.cjs.
export type DefinitionKind = 'agent' | 'skill';
export function inlineDefinition(title: string): { kind: DefinitionKind; name: string } | undefined {
  const match = /^(agent|skill):[ \t]+`([a-z][a-z0-9_-]*)`$/.exec(title);
  return match ? { kind: match[1] as DefinitionKind, name: match[2] } : undefined;
}
export function definitionTitle(kind: DefinitionKind, name: string): string {
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) throw new Error('Use a lowercase name, starting with a letter. / 名前は小文字の英字で始め、英数字・_・-で入力してください。');
  return `${kind}: \`${name}\``;
}
export function definitionBody(kind: DefinitionKind, description: string, model: string, instructions: string): string {
  const settings = [description && `description: ${JSON.stringify(description)}`, kind === 'agent' && model && `model: ${JSON.stringify(model)}`].filter(Boolean);
  return (settings.length ? `---\n${settings.join('\n')}\n---\n\n` : '') + instructions;
}
export const promptExpressions = [
  ['github.repository', 'Repository', 'リポジトリ名'],
  ['github.actor', 'Actor', '実行したユーザー'],
  ['github.event.issue.number', 'Issue number', 'Issue番号'],
  ['github.event.issue.title', 'Issue title', 'Issueのタイトル'],
  ['github.event.pull_request.number', 'Pull request number', 'PR番号'],
  ['github.event.pull_request.title', 'Pull request title', 'PRのタイトル'],
  ['github.run_id', 'Run ID', '実行ID'],
  ['github.workflow', 'Workflow name', 'Workflow名']
] as const;
export function runtimeImport(target: string, optional: boolean): string {
  target = target.trim();
  if (!target || /[\s{}\\\u0000-\u001f]/.test(target)) throw new Error('Enter a file path or HTTP(S) URL without spaces. / 空白を含まないファイルパスかHTTP(S) URLを入力してください。');
  const range = /:(\d+)(?:-(\d+))?$/.exec(target);
  if (range && (+range[1] < 1 || range[2] && +range[2] < +range[1])) throw new Error('Invalid line range. / 行範囲が不正です。');
  const path = range ? target.slice(0, range.index) : target;
  if (/^https?:\/\//.test(path)) {
    const url = new URL(path);
    if (!url.hostname || url.username || url.password) throw new Error('Use a public URL without credentials. / 認証情報を含まない公開URLを入力してください。');
  } else if (path.startsWith('/') || path.includes(':') || path.split('/').some(part => part === '..' || part === '.') || path === '.github') {
    throw new Error('Files must stay inside .github. / ファイルは.github内の相対パスで指定してください。');
  }
  return `{{#runtime-import${optional ? '?' : ''} ${target}}}`;
}
export function conditionalPrompt(expression: string, content: string): string {
  if (!expression.trim() || /[{}\r\n\0]/.test(expression) || /\{\{#if\b|\{\{\/if\}\}|\{\{else\}\}/.test(content)) throw new Error('Use one condition without nested blocks or else. / 条件は1つにし、条件の入れ子やelseは使わないでください。');
  return `{{#if ${expression.trim()}}}\n${content}\n{{/if}}`;
}

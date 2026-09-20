import type { FlowEdit, FlowModel, FlowStep, JobGraph, FlowOrigin } from '../src/core/flow';
import { builtInJobs, jobStepSections, fields, type Group, type StepSection } from '../src/core/fields';

export type FlowMode = 'flow' | 'instructions' | 'settings' | 'overview';
export type FlowSelection = { type: 'jobs' } | { type: 'builtin' | 'job'; id: string } | { type: 'step'; lane: 'before' | 'after' | 'job'; index: number; job?: string; section?: StepSection } | { type: 'instruction'; index: number };
interface View {
  model: FlowModel; mode: FlowMode; selection?: FlowSelection; generated?: JobGraph & { label: string }; error: boolean;
  select(selection: FlowSelection): void; group(group: Group): void; send(type: string, extra?: object): void; pending(): void;
}
const t = (en: string, ja: string) => document.documentElement.lang === 'ja' ? ja : en;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
function button(text: string, action: () => void, disabled = false) { const b = el('button', text); b.type = 'button'; b.onclick = action; b.disabled = disabled; return b; }
function submit(view: View, edit: FlowEdit) { view.send('flow', { edit }); }
const originLabel = (origin: FlowOrigin) => origin === 'user' ? t('User-defined', 'ユーザー定義') : origin === 'generated' ? t('gh-aw generated', 'gh-aw自動生成') : t('Reference / unverified', '参照・未確認');
function badge(origin: FlowOrigin) { const b = el('span', originLabel(origin), 'origin-badge'); b.dataset.origin = origin; return b; }
export function drawFlowDiagram(parent: HTMLElement, view: View) {
  parent.replaceChildren(el('h2', view.mode === 'instructions' ? t('Markdown body', '本文') : t('Jobs and steps', 'ジョブとステップ')));
  const list = el('div', undefined, 'resource-list');
  if (view.mode === 'instructions') {
    parent.append(el('p', t('Choose a heading to edit the instructions in Markdown.', '見出しを選ぶと、Markdownの指示を編集できます。'), 'hint'));
    parent.append(button(t('Add instruction', '手順を追加'), () => { submit(view, { action: 'instruction.add', title: t('New instruction', '新しい手順'), text: '' }); view.select({ type: 'instruction', index: view.model.instructions.length }); }, view.error));
    view.model.instructions.forEach((section, index) => {
      const b = button(section.heading ? section.title : t('Introduction', '指示の概要'), () => view.select({ type: 'instruction', index }));
      b.dataset.nodeId = `instruction-${index}`; b.setAttribute('aria-pressed', String(view.selection?.type === 'instruction' && view.selection.index === index));
      list.append(b);
    });
    parent.append(list);
    return;
  }
  parent.append(el('p', t('Custom jobs own their steps. Generated jobs accept only supported Markdown settings.', '独自ジョブはステップまで編集できます。自動生成ジョブは対応するMarkdown設定だけを追加できます。'), 'hint'));
  const add = el('form', undefined, 'add-job');
  const label = el('label', t('New job ID', '追加するジョブのID')); label.htmlFor = 'new-job-id';
  const id = el('input'); id.id = 'new-job-id'; id.placeholder = 'report'; id.required = true; id.pattern = '[A-Za-z_][A-Za-z0-9_-]{0,79}'; id.oninput = view.pending;
  const create = el('button', t('Add job', 'ジョブを追加')); create.type = 'submit'; create.disabled = view.error;
  add.append(label, id, create); add.onsubmit = event => { event.preventDefault(); submit(view, { action: 'job.add', job: id.value }); view.select({ type: 'job', id: id.value }); };
  const kinds = el('div', undefined, 'job-kinds');
  kinds.append(el('strong', t('Custom jobs · full definition', '独自ジョブ · 処理全体を作成')), el('p', t('Add a job ID, then edit its runner, condition, dependencies and steps.', 'IDを追加すると、実行環境・条件・依存先・ステップまで編集できます。'), 'hint'), add);
  for (const job of view.model.jobs.filter(job => !builtInJobs.includes(job.id))) {
    const b = button(job.name, () => view.select({ type: 'job', id: job.id })); b.dataset.nodeId = job.id; b.dataset.origin = 'user'; b.setAttribute('aria-pressed', String(view.selection?.type === 'job' && view.selection.id === job.id));
    b.append(el('small', job.needs.length ? job.needs.join(', ') : t('No dependencies', '依存なし'))); list.append(b);
  }
  kinds.append(list, el('strong', t('Generated jobs · settings only', '自動生成ジョブ · 設定を追加')), el('p', t('The compiler builds these jobs; the fields add only supported settings.', 'ジョブ本体はgh-awが作ります。対応する設定だけを追加できます。'), 'hint'));
  const managed = el('div', undefined, 'resource-list');
  for (const id of ['pre_activation', 'activation', 'agent', 'detection', 'safe_outputs', 'conclusion']) {
    const b = button(id, () => view.select({ type: 'builtin', id })); b.dataset.builtinId = id; b.dataset.origin = 'generated'; b.setAttribute('aria-pressed', String(view.selection?.type === 'builtin' && view.selection.id === id)); managed.append(b);
  }
  kinds.append(managed);
  parent.append(kinds);
  const lanes = el('div', undefined, 'lane-list');
  for (const lane of ['before', 'after'] as const) {
    const entries = lane === 'before' ? view.model.before : view.model.after;
    const section = el('section', undefined, 'lane-shortcut');
    section.append(el('h3', lane === 'before' ? t('Before the agent', 'エージェントの前処理') : t('After the agent', 'エージェントの後処理')));
    for (const step of entries) section.append(button(step.name, () => view.select({ type: 'step', lane, index: step.index })));
    const editable = lane === 'before' ? view.model.beforeEditable : view.model.afterEditable;
    section.append(button(t('+ Command', '＋ コマンド'), () => { submit(view, { action: 'step.add', lane, kind: 'run' }); view.select({ type: 'step', lane, index: entries.length }); }, view.error || !editable));
    section.append(button(t('+ Action', '＋ Action'), () => { submit(view, { action: 'step.add', lane, kind: 'uses' }); view.select({ type: 'step', lane, index: entries.length }); }, view.error || !editable));
    lanes.append(section);
  }
  parent.append(lanes);
}
export function drawAgentDependencies(parent: HTMLElement, view: View) {
  const jobs = view.model.jobs.filter(j => j.editable); if (!jobs.length) return;
  const form = el('form', undefined, 'dependencies'); form.append(el('h3', t('Run agent after these jobs', 'エージェントの前に完了させるジョブ')));
  for (const job of jobs) { const label = el('label', undefined, 'check-label'), input = el('input'); input.type = 'checkbox'; input.value = job.id; input.checked = view.model.agentNeeds.includes(job.id); input.disabled = view.error; input.onchange = view.pending; label.append(input, document.createTextNode(job.name)); form.append(label); }
  const apply = el('button', t('Apply agent dependencies', 'エージェントの依存関係を適用')); apply.type = 'submit'; apply.disabled = view.error; form.append(apply);
  form.onsubmit = e => { e.preventDefault(); submit(view, { action: 'agent.needs', value: Array.from(form.querySelectorAll<HTMLInputElement>('input:checked')).map(i => i.value) }); }; parent.append(form);
}
export function drawFlowInspector(parent: HTMLElement, view: View): boolean {
  const selection = view.selection; if (!selection) return false;
  parent.replaceChildren();
  const source = (path: (string | number)[]) => parent.append(button(t('Go to source', 'ソースへ移動'), () => view.send('flowSource', { path })));
  if (selection.type === 'jobs') {
    parent.append(el('h2', t('Jobs in Markdown', 'Markdownのジョブ')), el('p', t('Choose a custom job to edit its full definition. Choose a generated job to add supported settings. Create a custom job with the ID form on the left.', '独自ジョブでは処理全体を編集できます。自動生成ジョブには対応する設定を追加します。新しい独自ジョブは左のID欄から作成します。'), 'hint'));
    parent.append(button(t('Go to jobs in Markdown', 'Markdownのjobsへ移動'), () => view.send('flowSource', { path: ['jobs'] })));
    return true;
  }
  if (selection.type === 'builtin') {
    const job = view.model.jobs.find(j => j.id === selection.id);
    const emitted = view.generated?.jobs.find(j => j.id === selection.id || selection.id === 'safe-outputs' && j.id === 'safe_outputs');
    const id = selection.id;
    parent.append(el('h2', id), badge('generated'), el('p', t('gh-aw builds this job. The fields below add configuration to its Markdown definition; compiler-required values remain in force.', 'このジョブはgh-awが生成します。下の項目はMarkdownの定義に設定を追加するもので、コンパイラが必要とする値は維持されます。'), 'hint'));
    if (!emitted) parent.append(el('p', t('This job is not in the last compiled result. The relevant feature or trigger may need to be enabled before these settings compile.', '最後の生成結果にはこのジョブがありません。設定を使うには、対応する機能やトリガーを有効にする必要がある場合があります。'), 'hint'));
    if (job) source(['jobs', id]);
    if (id === 'safe_outputs' || id === 'safe-outputs') parent.append(button(t('Edit Safe Outputs features', 'Safe Outputsの機能を編集'), () => view.group('safe-outputs')));
    if (id === 'agent') parent.append(button(t('Edit engine and tools', 'Engineとツールを編集'), () => view.group('engine')));
    const setting = (field: string, value: string | number | string[]) => submit(view, { action: 'builtin.edit', job: id, field, value });
    const clear = (field: string) => submit(view, { action: 'builtin.clear', job: id, field });
    property(parent, view, 'builtin-if', t('Additional condition (if)', '追加する実行条件（if）'), String(job?.values.if ?? ''), value => value ? setting('if', value) : clear('if'));
    if (job?.values.if !== undefined) parent.append(button(t('Remove additional condition', '追加条件を削除'), () => clear('if'), view.error));
    parent.append(el('p', t('Additional dependencies are combined with compiler dependencies. Clearing this list does not remove compiler prerequisites.', '追加する依存先はコンパイラの依存先と結合されます。ここからコンパイラの前提ジョブは削除できません。'), 'hint'));
    const deps = el('form', undefined, 'dependencies'); deps.append(el('h3', t('Additional dependencies', '追加する依存先')));
    const choices = new Set([...view.model.jobs.map(j => j.id), ...(view.generated?.jobs.map(j => j.id) ?? []), ...(job?.needs ?? [])]); choices.delete(id);
    const downstream = (choice: string, visited = new Set<string>()): boolean => {
      if (choice === id) return true;
      if (visited.has(choice)) return false;
      visited.add(choice);
      const source = view.generated?.jobs.find(job => job.id === choice) ?? view.model.jobs.find(job => job.id === choice);
      return !!source?.needs.some(need => downstream(need, visited));
    };
    for (const choice of choices) {
      if (!job?.needs.includes(choice) && downstream(choice)) continue;
      const label = el('label', undefined, 'check-label'), input = el('input'); input.type = 'checkbox'; input.value = choice; input.checked = job?.needs.includes(choice) ?? false; input.disabled = view.error; input.onchange = view.pending; label.append(input, document.createTextNode(choice)); deps.append(label);
    }
    const apply = el('button', t('Apply additional dependencies', '追加依存先を適用')); apply.type = 'submit'; apply.disabled = view.error;
    deps.append(apply); deps.onsubmit = e => { e.preventDefault(); const selected = Array.from(deps.querySelectorAll<HTMLInputElement>('input:checked')).map(input => input.value); selected.length ? setting('needs', selected) : clear('needs'); }; parent.append(deps);
    if (job?.values.needs !== undefined) parent.append(button(t('Remove additional dependencies', '追加依存先を削除'), () => clear('needs'), view.error));
    if (['agent', 'detection'].includes(id)) {
      const form = el('form', undefined, 'field'), label = el('label', t('Timeout (minutes)', '制限時間（分）')), input = el('input'); input.id = 'builtin-timeout'; input.type = 'number'; input.min = '1'; input.max = '2147483647'; input.step = '1'; input.value = String(job?.values['timeout-minutes'] ?? ''); input.oninput = view.pending; label.htmlFor = input.id;
      const apply = el('button', t('Apply', '適用')); apply.type = 'submit'; apply.disabled = view.error;
      form.append(label, input, apply); form.onsubmit = e => { e.preventDefault(); if (input.value) setting('timeout-minutes', Number(input.value)); else clear('timeout-minutes'); }; parent.append(form);
    }
    const permissions = el('details'); permissions.append(el('summary', t('Additional permissions', '追加する権限')));
    permissions.append(el('p', t('Permissions are added to compiler-required scopes; they do not replace them.', '権限はコンパイラが必要とする権限へ追加され、置き換えません。'), 'hint'));
    const permission = el('form', undefined, 'field'), scope = el('select'), level = el('select'); scope.id = 'builtin-permission-scope'; level.id = 'builtin-permission-level';
    const permissionFields = fields.filter(f => f.group === 'permissions');
    for (const field of permissionFields) { const option = el('option', field.path[1]); option.value = field.path[1]; scope.append(option); }
    const configured = job?.values.permissions;
    const updateLevels = () => {
      level.replaceChildren(); const field = permissionFields.find(f => f.path[1] === scope.value)!;
      for (const value of field.options ?? []) { const option = el('option', value); option.value = value; level.append(option); }
      const current = configured && typeof configured === 'object' && !Array.isArray(configured) ? configured[scope.value] : undefined;
      if (typeof current === 'string' && field.options?.includes(current)) level.value = current;
    };
    scope.onchange = updateLevels; updateLevels();
    const scopeLabel = el('label', t('Permission scope', '権限のスコープ')); scopeLabel.htmlFor = scope.id;
    const levelLabel = el('label', t('Level', '許可値')); levelLabel.htmlFor = level.id;
    const permissionApply = el('button', t('Add permission', '権限を追加')); permissionApply.type = 'submit'; permissionApply.disabled = view.error;
    permission.append(scopeLabel, scope, levelLabel, level, permissionApply); permission.onsubmit = e => { e.preventDefault(); setting('permissions.' + scope.value, level.value); }; permissions.append(permission);
    if (configured && typeof configured === 'object' && !Array.isArray(configured)) for (const [name, value] of Object.entries(configured)) {
      const row = el('p', `${name}: ${String(value)} `); row.append(button(t('Remove addition', '追加設定を削除'), () => clear('permissions.' + name), view.error)); permissions.append(row);
    }
    parent.append(permissions);
    for (const section of jobStepSections(id)) {
      const list = section === 'steps' ? job?.steps ?? [] : section === 'pre-steps' ? job?.preSteps ?? [] : job?.setupSteps ?? [];
      if (section === 'setup-steps') parent.append(el('p', t('Setup steps run at the start of this generated job, before compiler setup.', '準備ステップはこの生成ジョブの先頭で、コンパイラが追加する準備処理より前に動きます。'), 'hint'));
      if (section === 'steps' && id === 'activation') parent.append(el('p', t('Activation steps are inserted before artifact staging.', 'activationのステップは成果物の準備より前に挿入されます。'), 'hint'));
      stepList(parent, view, list, 'job', id, section);
    }
    return true;
  }
  if (selection.type === 'instruction') {
    const s = view.model.instructions[selection.index]; if (!s) return true;
    parent.append(el('h2', s.heading ? s.title : t('Introduction', '指示の概要')));
    parent.append(badge('user'), el('p', t('Edit these instructions in the source Markdown.', 'この指示はユーザーが編集し、Markdownに保存します。'), 'hint'));
    parent.append(button(t('Go to source', 'ソースへ移動'), () => view.send('flowSource', { instruction: s.index })));
    const form = el('form');
    let title: HTMLInputElement | undefined;
    if (s.heading) { title = el('input'); title.value = s.title; title.id = 'instruction-title'; title.oninput = view.pending; title.disabled = view.error; title.required = true; const label = el('label', t('Step title', '手順の名前')); label.htmlFor = title.id; form.append(label, title); }
    const textarea = el('textarea'); textarea.id = 'instruction-text'; textarea.rows = 12; textarea.value = s.text; textarea.oninput = view.pending; textarea.disabled = view.error;
    const label = el('label', t('Instructions (Markdown)', '指示の内容（Markdown）')); label.htmlFor = textarea.id;
    const apply = el('button', t('Apply instructions', '指示を適用')); apply.type = 'submit'; apply.disabled = view.error;
    const formatting = el('div', undefined, 'flow-actions'); formatting.setAttribute('role', 'group'); formatting.setAttribute('aria-label', t('Text formatting', '本文の書式'));
    for (const [name, prefix, suffix] of [[t('Bold', '太字'), '**', '**'], [t('List', '箇条書き'), '- ', ''], [t('Code', 'コード'), '`', '`']] as const) {
      formatting.append(button(name, () => { const start = textarea.selectionStart, end = textarea.selectionEnd; const value = textarea.value.slice(start, end); textarea.setRangeText(prefix + value + suffix, start, end, 'select'); textarea.focus(); view.pending(); }, view.error));
    }
    form.append(label, formatting, textarea, apply); form.onsubmit = e => { e.preventDefault(); submit(view, { action: 'instruction.edit', index: s.index, title: title?.value, text: textarea.value }); }; parent.append(form);
    if (s.heading) {
      const actions = el('div', undefined, 'flow-actions');
      for (const direction of [-1, 1] as const) actions.append(button(direction === -1 ? t('Move earlier', '前へ') : t('Move later', '後へ'), () => { submit(view, { action: 'instruction.move', index: s.index, direction }); view.select({ type: 'instruction', index: s.index + direction }); }, view.error || !view.model.instructions[s.index + direction]?.heading));
      actions.append(button(t('Delete instruction', '手順を削除'), () => { submit(view, { action: 'instruction.remove', index: s.index }); view.select({ type: 'instruction', index: Math.max(0, s.index - 1) }); }, view.error)); parent.append(actions);
    }
    return true;
  }
  if (selection.type === 'job') {
    const job = view.model.jobs.find(j => j.id === selection.id); if (!job) return true;
    parent.append(el('h2', job.name)); source(['jobs', job.id]);
    parent.append(badge(job.origin ?? 'user'), el('p', t('Edit the Markdown definition. gh-aw can supplement the generated job.', 'Markdownの定義を編集します。生成ジョブにはgh-awによる補完が入る場合があります。'), 'hint'));
    if (!job.editable) { parent.append(el('p', t('Compiler-managed or advanced job. Edit its source configuration.', 'CLIが管理するジョブ、または高度な構文です。設定はソースで編集してください。'))); return true; }
    const makeEdit = (field: string, value: string | string[]) => submit(view, { action: 'job.edit', job: job.id, field, value });
    property(parent, view, 'job-name', t('Job name', 'ジョブ名'), String(job.values.name ?? job.id), value => makeEdit('name', value));
    const reusable = typeof job.values.uses === 'string';
    if (reusable) { parent.append(el('p', `${t('Reusable workflow', '再利用Workflow')}: ${job.values.uses}`, 'hint')); withFields(parent, view, job.values.with, { lane: 'job', job: job.id }, ['jobs', job.id, 'with']); }
    else property(parent, view, 'job-runner', t('Runner', '実行環境'), typeof job.values['runs-on'] === 'string' ? job.values['runs-on'] : '', value => makeEdit('runs-on', value));
    property(parent, view, 'job-if', t('Condition (if)', '実行条件（if）'), String(job.values.if ?? ''), value => makeEdit('if', value));
    const form = el('form', undefined, 'dependencies'); form.append(el('h3', t('Run after these jobs', 'これらのジョブの完了後に実行')));
    const choices = new Set(['agent', 'activation', 'pre_activation', ...(view.generated?.jobs.map(j => j.id) ?? []), ...view.model.jobs.map(j => j.id), ...job.needs]); choices.delete(job.id);
    for (const id of choices) {
      const label = el('label', undefined, 'check-label'), input = el('input'); input.type = 'checkbox'; input.value = id; input.checked = job.needs.includes(id); input.disabled = view.error; input.onchange = view.pending; label.append(input, document.createTextNode(id)); form.append(label);
    }
    const apply = el('button', t('Apply dependencies', '依存関係を適用')); apply.type = 'submit'; apply.disabled = view.error; form.append(apply);
    form.onsubmit = e => { e.preventDefault(); makeEdit('needs', Array.from(form.querySelectorAll<HTMLInputElement>('input:checked')).map(i => i.value)); }; parent.append(form);
    if (job.implicit) parent.append(el('p', t('needs is omitted; the CLI may add dependencies. Applying an empty selection sets explicit independent execution.', 'needsは未指定です。CLIが依存を補完する場合があります。選択なしで適用すると、依存なしを明示します。'), 'hint'));
    if (!reusable) for (const section of jobStepSections(job.id)) stepList(parent, view, section === 'steps' ? job.steps : section === 'pre-steps' ? job.preSteps ?? [] : job.setupSteps ?? [], 'job', job.id, section);
    parent.append(button(t('Delete job', 'ジョブを削除'), () => submit(view, { action: 'job.remove', job: job.id }), view.error)); return true;
  }
  if (selection.type !== 'step') return false;
  const job = selection.lane === 'job' ? view.model.jobs.find(j => j.id === selection.job) : undefined;
  const list = selection.lane === 'job' ? selection.section === 'pre-steps' ? job?.preSteps ?? [] : selection.section === 'setup-steps' ? job?.setupSteps ?? [] : job?.steps ?? [] : selection.lane === 'before' ? view.model.before : view.model.after;
  const step = list[selection.index]; if (!step) return true;
  parent.append(el('h2', step.name));
  parent.append(badge('user'), el('p', t('This step is defined in your Markdown.', 'このステップはMarkdownでユーザーが定義したものです。'), 'hint'));
  const path = selection.lane === 'job' ? ['jobs', selection.job!, selection.section ?? 'steps', step.index] : [selection.lane === 'before' ? 'steps' : 'post-steps', step.index]; source(path);
  if (!step.editable) { parent.append(el('p', t('Edit this advanced step in source.', 'この高度なステップはソースで編集してください。'))); return true; }
  for (const field of ['name', ...(Object.hasOwn(step.values, 'uses') ? ['uses'] : ['run']), 'if', ...(!Object.hasOwn(step.values, 'uses') ? ['shell', 'working-directory'] : [])]) {
    const labels: Record<string, string> = { name: t('Step name', 'ステップ名'), run: t('Command', '実行コマンド'), uses: 'Action (uses)', if: t('Condition (if)', '実行条件（if）'), shell: t('Shell', 'シェル'), 'working-directory': t('Working directory', '作業ディレクトリ') };
    property(parent, view, `step-${field}`, labels[field], String(step.values[field] ?? ''), value => submit(view, { action: 'step.edit', lane: selection.lane, job: selection.job, index: step.index, field, value }), field === 'run');
  }
  if (typeof step.values.uses === 'string') withFields(parent, view, step.values.with, { lane: selection.lane, job: selection.job, section: selection.section, index: step.index }, [...path, 'with']);
  const actions = el('div', undefined, 'flow-actions');
  for (const direction of [-1, 1] as const) actions.append(button(direction === -1 ? t('Move earlier', '前へ') : t('Move later', '後へ'), () => { submit(view, { action: 'step.move', lane: selection.lane, job: selection.job, index: step.index, direction }); view.select({ ...selection, index: step.index + direction }); }, view.error || !list[step.index + direction]));
  actions.append(button(t('Delete step', 'ステップを削除'), () => {
    submit(view, { action: 'step.remove', lane: selection.lane, job: selection.job, index: step.index });
    if (list.length > 1) view.select({ ...selection, index: Math.max(0, step.index - 1) });
    else if (selection.job) view.select({ type: builtInJobs.includes(selection.job) ? 'builtin' : 'job', id: selection.job });
    else view.group('engine');
  }, view.error)); parent.append(actions);
  const advanced = el('details'); advanced.append(el('summary', t('All step settings', 'ステップの全設定')), el('pre', JSON.stringify(step.values, null, 2))); parent.append(advanced); return true;
}
function withFields(parent: HTMLElement, view: View, value: unknown, location: Pick<FlowEdit, 'lane' | 'job' | 'section' | 'index'>, sourcePath: (string | number)[]) {
  const section = el('section', undefined, 'with-fields');
  section.append(el('h3', t('Action inputs (with)', 'Actionの入力値（with）')));
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) {
    section.append(el('p', t('Edit this advanced with setting in Markdown.', 'このwith設定はMarkdownで編集してください。'), 'hint'), button(t('Go to source', 'ソースへ移動'), () => view.send('flowSource', { path: sourcePath })));
    parent.append(section); return;
  }
  const entries = value ? Object.entries(value) : [];
  for (const [key, current] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,79}$/.test(key) || !['string', 'number', 'boolean'].includes(typeof current)) {
      const row = el('div', key, 'field'); row.append(button(t('Edit in Markdown', 'Markdownで編集'), () => view.send('flowSource', { path: sourcePath }))); section.append(row); continue;
    }
    const form = el('form', undefined, 'field'), label = el('label', key);
    const input = typeof current === 'boolean' ? el('select') : el('input'); input.id = `with-${key}`; label.htmlFor = input.id;
    if (input instanceof HTMLSelectElement) for (const optionValue of ['true', 'false']) { const option = el('option', optionValue); option.value = optionValue; input.append(option); }
    else if (typeof current === 'number') { input.type = 'number'; input.step = 'any'; input.required = true; }
    input.value = String(current); input.disabled = view.error; input.oninput = view.pending;
    const apply = el('button', t('Apply', '適用')); apply.type = 'submit'; apply.disabled = view.error;
    const remove = button(t('Remove input', '入力値を削除'), () => submit(view, { action: 'with.remove', ...location, field: key }), view.error);
    form.append(label, input, apply, remove);
    form.onsubmit = event => { event.preventDefault(); submit(view, { action: 'with.edit', ...location, field: key, value: typeof current === 'boolean' ? input.value === 'true' : typeof current === 'number' ? Number(input.value) : input.value }); };
    section.append(form);
  }
  const add = el('form', undefined, 'field');
  const keyLabel = el('label', t('Input name', '入力名')), key = el('input'); key.id = 'new-with-key'; key.pattern = '[A-Za-z_][A-Za-z0-9_-]{0,79}'; key.required = true; keyLabel.htmlFor = key.id;
  const valueLabel = el('label', t('Value', '値')), input = el('input'); input.id = 'new-with-value'; input.required = true; valueLabel.htmlFor = input.id;
  const typeLabel = el('label', t('Value type', '値の種類')), type = el('select'); type.id = 'new-with-type'; typeLabel.htmlFor = type.id;
  for (const [id, label] of [['text', t('Text', '文字列')], ['number', t('Number', '数値')], ['boolean', t('Boolean', '真偽値')]]) { const option = el('option', label); option.value = id; type.append(option); }
  key.oninput = view.pending;
  input.oninput = () => { input.setCustomValidity(''); view.pending(); };
  type.onchange = () => {
    input.setCustomValidity(''); input.type = type.value === 'number' ? 'number' : 'text'; input.step = type.value === 'number' ? 'any' : '';
    input.pattern = type.value === 'boolean' ? 'true|false' : '';
    input.placeholder = type.value === 'boolean' ? 'true / false' : '';
    if (type.value === 'boolean') input.value = 'true';
    view.pending();
  };
  key.disabled = input.disabled = type.disabled = view.error;
  const submitButton = el('button', t('Add input', '入力値を追加')); submitButton.type = 'submit'; submitButton.disabled = view.error;
  add.append(keyLabel, key, valueLabel, input, typeLabel, type, submitButton);
  add.onsubmit = event => {
    event.preventDefault();
    if (entries.some(([name]) => name === key.value)) { input.setCustomValidity(t('Input name already exists.', '同じ入力名が既にあります。')); input.reportValidity(); return; }
    input.setCustomValidity('');
    const parsed = type.value === 'number' ? Number(input.value) : type.value === 'boolean' ? input.value === 'true' : input.value;
    if (type.value === 'number' && !Number.isFinite(parsed)) { input.setCustomValidity(t('Enter a number.', '数値を入力してください。')); input.reportValidity(); return; }
    submit(view, { action: 'with.edit', ...location, field: key.value, value: parsed });
  };
  section.append(add); parent.append(section);
}
function stepList(parent: HTMLElement, view: View, steps: FlowStep[], lane: 'job', job: string, section: StepSection = 'steps') {
  parent.append(el('h3', section === 'steps' ? t('Steps', 'ステップ') : section === 'pre-steps' ? t('Pre-steps', '前処理ステップ') : t('Setup steps', '準備ステップ')));
  const list = el('ol', undefined, 'editable-steps'); steps.forEach(step => { const item = el('li'); item.append(button(step.name, () => view.select({ type: 'step', lane, job, section, index: step.index }))); list.append(item); }); parent.append(list);
  for (const kind of ['run', 'uses'] as const) parent.append(button(section === 'pre-steps' ? kind === 'run' ? t('+ Pre-step command', '＋ 前処理コマンド') : t('+ Pre-step Action', '＋ 前処理Action') : section === 'setup-steps' ? kind === 'run' ? t('+ Setup command', '＋ 準備コマンド') : t('+ Setup Action', '＋ 準備Action') : kind === 'run' ? t('+ Command', '＋ コマンド') : t('+ Action', '＋ Action'), () => { submit(view, { action: 'step.add', lane, job, section, kind }); view.select({ type: 'step', lane, job, section, index: steps.length }); }, view.error));
}
function property(parent: HTMLElement, view: View, id: string, name: string, value: string, save: (value: string) => void, multiline = false) {
  const form = el('form', undefined, 'field'), label = el('label', name); label.htmlFor = id;
  const input = multiline ? el('textarea') : el('input'); input.id = id; input.value = value; input.oninput = view.pending; input.disabled = view.error;
  if (input instanceof HTMLTextAreaElement) input.rows = 7;
  const apply = el('button', t('Apply', '適用')); apply.type = 'submit'; apply.disabled = view.error; form.append(label, input, apply); form.onsubmit = e => { e.preventDefault(); save(input.value); }; parent.append(form);
}

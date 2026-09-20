import { groups, type Field, type Group, type Value } from '../src/core/fields';
import { drawFlowDiagram, drawFlowInspector, drawAgentDependencies, type FlowMode, type FlowSelection } from './flow';
import { drawOverview } from './overview';
import type { FlowModel, JobGraph } from '../src/core/flow';
declare function acquireVsCodeApi(): { postMessage(message: unknown): void; getState(): { selected?: Group; mode?: FlowMode } | undefined; setState(state: unknown): void };
const api = acquireVsCodeApi();
const uri = document.body.dataset.uri!;
let japanese = document.documentElement.lang === 'ja';
const t = (en: string, ja: string) => japanese ? ja : en;
type FormField = Field & { value?: unknown; reason: string };
interface State {
  language: 'ja' | 'en'; languageSetting: 'ja' | 'en';
  type: 'state'; uri: string; version: number; dirty: boolean; trusted: boolean; error: string; status: string; parseMs: number;
  model?: { data: Record<string, Value>; fields: FormField[]; advanced: { path: string[]; group: Group }[]; body: string; shared: boolean; imports: string[]; flow: FlowModel };
  generated?: JobGraph & { label: string }; graphError?: string;
  dependencies: { path: string; dirty: boolean }[];
  compile?: { phase: string; message?: string; issues?: { message: string; severity: string }[]; record?: { output: string; version: string; time: string } };
}
let state: State | undefined;
let selected: Group = api.getState()?.selected ?? 'metadata';
let mode: FlowMode = api.getState()?.mode ?? 'settings';
if (!['settings', 'instructions', 'flow', 'overview'].includes(mode)) mode = 'settings';
let flowSelection: FlowSelection | undefined = mode === 'instructions' ? { type: 'instruction', index: 0 } : undefined;
let pending = false;
const app = document.getElementById('app')!;
function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
function send(type: string, extra: object = {}) {
  if (type === 'edit' || type === 'flow') setEditBusy(true);
  api.postMessage({ type, uri, version: state?.version, ...extra });
}
function setEditBusy(busy: boolean) {
  properties.inert = diagram.inert = busy;
  properties.setAttribute('aria-busy', String(busy));
}
function button(label: string, action: () => void, className?: string) { const b = element('button', label, className); b.type = 'button'; b.onclick = action; return b; }
function localMessage(text: string): string { const parts = text.split(' / '); return parts.length === 2 ? parts[japanese ? 1 : 0] : text; }
const heading = element('header');
const toolbar = element('nav');
function drawChrome() {
  heading.replaceChildren(element('h1', 'Workflow Designer'), element('p', decodeURIComponent(uri.split('/').pop() ?? ''), 'subtitle'));
  const languages = element('div', undefined, 'language-switch'); languages.setAttribute('role', 'group'); languages.setAttribute('aria-label', 'Language / 言語');
  for (const [value, label] of [['ja', '日本語'], ['en', 'English']]) {
    const b = button(label, () => send('language', { value })); b.dataset.language = value; b.id = 'language-' + value; b.setAttribute('aria-pressed', String((state?.languageSetting ?? (japanese ? 'ja' : 'en')) === value)); languages.append(b);
  }
  heading.append(languages);
  toolbar.setAttribute('aria-label', t('Workflow actions', 'Workflowの操作'));
  toolbar.replaceChildren(button(t('Save and check', '保存して確認'), () => send('compile'), 'primary'), button(t('Open Markdown', 'Markdownを開く'), () => send('source')));
  diagram.setAttribute('aria-label', t('Markdown outline', 'Markdownの項目一覧')); tabs.setAttribute('aria-label', t('Editing sections', '編集する項目'));
}
const alerts = element('div'); alerts.id = 'alerts'; alerts.setAttribute('role', 'alert');
const status = element('div', '', 'status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
const layout = element('div', undefined, 'layout');
const diagram = element('section', undefined, 'diagram'); diagram.setAttribute('aria-label', t('Markdown outline', 'Markdownの項目一覧'));
const properties = element('section', undefined, 'properties');
layout.append(diagram, properties);
const results = element('section', undefined, 'results');
const tabs = element('nav', undefined, 'view-tabs'); tabs.setAttribute('aria-label', t('Editor views', '編集する表示'));
app.append(heading, toolbar, alerts, status, tabs, layout, results);
function drawTabs() {
  tabs.replaceChildren();
  layout.dataset.mode = mode;
  const views = [['settings', 'Settings', '設定'], ['instructions', 'Markdown body', '本文'], ['flow', 'Jobs and steps', 'ジョブとステップ'], ['overview', 'Flow view', 'フロー図']] as const;
  for (const [id, en, ja] of views) {
    const b = button(t(en, ja), () => changeMode(id)); b.setAttribute('aria-pressed', String(mode === id)); b.dataset.view = id; tabs.append(b);
  }
}
function changeMode(next: FlowMode) { mode = next; pending = false; flowSelection = next === 'instructions' ? { type: 'instruction', index: 0 } : undefined; api.setState({ selected, mode }); drawTabs(); drawGraph(); drawForm(); }
function selectFlow(selection: FlowSelection) {
  flowSelection = selection;
  if (selection.type === 'instruction') mode = 'instructions';
  drawTabs(); drawGraph(); drawForm();
  if (window.innerWidth < 1000) properties.scrollIntoView({ block: 'start' });
}
function flowView() {
  return { model: state!.model!.flow, mode, selection: flowSelection, generated: state?.generated, error: !!state?.error, select: selectFlow,
    group: (group: Group) => { flowSelection = undefined; selected = group; mode = 'settings'; api.setState({ selected, mode }); drawTabs(); drawGraph(); drawForm(); },
    send: (type: string, extra?: object) => { if (type === 'flow') pending = false; send(type, extra); }, pending: () => { pending = true; } };
}
function summary(group: Group): string {
  if (!state?.model) return '';
  const model = state.model;
  const value = group === 'metadata' ? model.data.name : group === 'instructions' ? `${model.body.length} ${t('characters', '文字')}` : group === 'imports' ? `${model.imports.length} ${t('references', '件の参照')}` : model.data[group];
  if (value === undefined) return t('Not declared', '未設定');
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return `${value.length} ${t('entries', '件')}`;
  if (value && typeof value === 'object') return Object.keys(value).join(', ');
  return String(value);
}
function drawGraph() {
  if (mode === 'overview' && state?.model) {
    diagram.setAttribute('aria-label', t('Workflow flow from Markdown', 'Markdownから分かる処理の流れ'));
    if (state.model.shared) { diagram.replaceChildren(element('h2', t('Shared component', '共有コンポーネント')), element('p', t('This Markdown has no trigger. Its jobs are part of an importing workflow; open that workflow to see its flow.', 'このMarkdownにはトリガーがありません。ジョブは参照元Workflowの一部です。処理の流れは参照元を開いて確認してください。'), 'hint')); return; }
    drawOverview(diagram, state.model.flow, state.model.data, job => {
      const declared = job.origin === 'generated' ? state?.model?.flow.jobs.find(candidate => candidate.id.replaceAll('-', '_') === job.id) : undefined;
      mode = 'flow'; flowSelection = { type: job.origin === 'user' ? 'job' : 'builtin', id: declared?.id ?? job.id };
      api.setState({ selected, mode }); drawTabs(); drawGraph(); drawForm();
    });
    return;
  }
  diagram.setAttribute('aria-label', t('Markdown outline', 'Markdownの項目一覧'));
  if (mode !== 'settings' && state?.model?.flow) { drawFlowDiagram(diagram, flowView()); if (state.graphError) diagram.append(element('p', state.graphError, 'diagnostic')); return; }
    diagram.replaceChildren(element('h2', t('Settings', '設定')), element('p', t('Choose a section to edit its Markdown fields.', '項目を選ぶと、そのMarkdown設定を編集できます。'), 'hint'));
    const list = element('div', undefined, 'resource-list');
    for (const group of groups) {
      const b = button('', () => { pending = false; selected = group.id; flowSelection = undefined; if (group.id === 'instructions') changeMode('instructions'); else { api.setState({ selected, mode }); drawGraph(); drawForm(); } });
      b.dataset.group = group.id; b.setAttribute('aria-pressed', String(selected === group.id));
      b.append(element('span', group.label[japanese ? 1 : 0]), element('small', summary(group.id))); list.append(b);
    }
    diagram.append(list);
}
function drawForm() {
  properties.hidden = mode === 'overview';
  if (mode === 'overview') return;
  if (state?.model?.flow && mode !== 'settings' && drawFlowInspector(properties, flowView())) return;
  properties.replaceChildren();
  properties.append(element('h2', groups.find(g => g.id === selected)!.label[japanese ? 1 : 0]), button(t('Go to source', 'ソースへ移動'), () => send('source', { group: selected })));
  properties.append(element('p', t('User-defined settings · saved in Markdown', 'ユーザー定義の設定 · Markdownに保存'), 'hint'));
  if (!state?.model) return;
  if (selected === 'instructions') { properties.append(button(t('Edit instruction steps', '指示の手順を編集'), () => changeMode('instructions')), element('pre', state.model.body)); return; }
  if (selected === 'engine') properties.append(button(t('Edit instruction steps', '指示の手順を編集'), () => changeMode('instructions')));
  if (selected === 'engine' && state.model.flow) drawAgentDependencies(properties, flowView());
  if (selected === 'imports') {
    properties.append(element('p', t('References only. Local dependencies are tracked transitively; remote imports are handled by gh aw.', '参照を表示しています。ローカル依存は推移的に追跡し、リモート参照はgh awが解決します。')));
    for (const ref of state.model.imports) properties.append(button(ref, () => send('import', { ref }), 'reference'));
    for (const dep of state.dependencies) properties.append(element('p', `${dep.dirty ? t('Unsaved: ', '未保存: ') : ''}${dep.path}`, 'hint'));
    return;
  }
  for (const f of state.model.fields.filter(f => f.group === selected)) {
    const form = element('form', undefined, 'field'); const id = f.path.join('.');
    const controller = state.model.fields.find(parent => ['presence', 'boolean'].includes(parent.kind) && parent.path.length < f.path.length && parent.path.every((part, i) => part === f.path[i]));
    if (controller) form.dataset.controller = controller.path.join('.');
    const label = element('label', f.label[japanese ? 1 : 0]); label.htmlFor = id;
    let input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    if (f.kind === 'boolean' || f.kind === 'presence' || f.kind === 'choice') {
      input = element('select');
      const values = f.kind === 'choice' ? f.options! : ['true', 'false'];
      const absent = element('option', t('Not set', '未設定')); absent.value = ''; input.append(absent);
      for (const value of values) { const option = element('option', value === 'true' ? t('Enabled', '有効') : value === 'false' ? t('Disabled', '無効') : value); option.value = value; input.append(option); }
      input.value = f.value === undefined ? '' : String(f.value);
    } else if (f.kind === 'list' || f.kind === 'schedule') {
      input = element('textarea'); input.rows = 3; input.value = Array.isArray(f.value) ? f.value.join('\n') : '';
    } else {
      input = element('input'); input.type = f.kind === 'number' ? 'number' : 'text'; if (f.kind === 'number') { input.min = f.path[0] === 'timeout-minutes' ? '1' : '0'; input.max = '2147483647'; input.step = '1'; }
      input.value = f.value === undefined || f.value === null ? '' : String(f.value);
    }
    input.id = id; input.disabled = !!state.error || !!f.reason; input.oninput = () => { pending = true; updateVisibility(); };
    const actions = element('div', undefined, 'field-actions');
    const apply = element('button', t('Apply', '適用')); apply.type = 'submit'; apply.disabled = input.disabled;
    const remove = button(t('Remove setting', '設定を削除'), () => { pending = false; send('edit', { field: id, remove: true }); }, 'secondary'); remove.disabled = !!state.error;
    actions.append(apply, remove); form.append(label, input, actions);
    if (f.options && f.kind !== 'choice') {
      const candidates = element('div', undefined, 'candidate-picker');
      const pick = element('select'); pick.id = id + '-candidate'; pick.disabled = input.disabled;
      const prompt = element('option', t('Choose a value…', '候補を選択…')); prompt.value = ''; pick.append(prompt);
      for (const value of f.options) { const option = element('option', value); option.value = value; pick.append(option); }
      const pickLabel = element('label', t('Suggestions', '候補')); pickLabel.htmlFor = pick.id;
      const add = button(f.kind === 'list' ? t('Add selected', '選択した値を追加') : t('Use selected', '選択した値を使う'), () => {
        if (!pick.value) return;
        if (f.kind === 'list') {
          const values = input.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
          if (!values.includes(pick.value)) input.value = [...values, pick.value].join('\n');
        } else input.value = pick.value;
        pending = true; input.focus();
      }); add.disabled = input.disabled;
      candidates.append(pickLabel, pick, add, element('p', t('Choose a suggestion or type your own value above, then Apply.', '候補から追加するか、上の欄に直接入力して「適用」を押します。'), 'hint'));
      form.insertBefore(candidates, actions);
    }
    if (f.reason) form.append(element('p', t('Source editing required: ', 'ソースで編集してください: ') + localMessage(f.reason), 'hint'), button(t('Edit in Markdown', 'Markdownで編集'), () => send('configSource', { path: f.path })));
    form.onsubmit = e => {
      e.preventDefault(); let value: Value = input.value;
      if (f.kind === 'boolean' || f.kind === 'presence') { if (!input.value) return; value = input.value === 'true'; }
      else if (f.kind === 'number') { if (!input.value) return; value = Number(input.value); }
      else if (f.kind === 'list' || f.kind === 'schedule') value = input.value.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
      pending = false; send('edit', { field: id, value });
    };
    properties.append(form);
  }
  updateVisibility();
  const advanced = state.model.advanced.filter(item => item.group === selected);
  if (advanced.length) {
    const section = element('section', undefined, 'advanced-settings'); section.append(element('h3', t('Additional settings', 'その他の設定')), element('p', t('These settings are preserved. Open the matching Markdown line to edit them.', 'これらの設定はそのまま保持します。対応するMarkdownの行を開いて編集できます。'), 'hint'));
    for (const item of advanced) {
      const row = element('div', undefined, 'field-actions');
      const controller = state.model.fields.find(parent => ['presence', 'boolean'].includes(parent.kind) && parent.path.length < item.path.length && parent.path.every((part, i) => part === item.path[i]));
      if (controller) row.dataset.controller = controller.path.join('.');
      row.append(element('code', item.path.join('.')), button(t('Edit in Markdown', 'Markdownで編集'), () => send('configSource', { path: item.path }))); section.append(row);
    }
    properties.append(section);
  }
  updateVisibility();
}
function updateVisibility() {
  for (const form of properties.querySelectorAll<HTMLElement>('[data-controller]')) {
    const control = document.getElementById(form.dataset.controller!) as HTMLSelectElement | null;
    form.hidden = control?.value !== 'true';
  }
}
function render() {
  if (!state) return;
  app.dataset.version = String(state.version);
  drawChrome();
  status.textContent = `${state.dirty ? t('Unsaved changes', '未保存の変更あり') : t('Source saved', 'ソース保存済み')} · ${localMessage(state.status)}`;
  if (state.error) alerts.textContent = t('Current edits are not reflected below. Fix the source to resume GUI editing.\n', '現在の編集内容は未反映です。ソースを修正するとGUI編集を再開できます。\n') + state.error;
  const compile = toolbar.querySelector<HTMLButtonElement>('.primary')!;
  compile.disabled = !state.trusted || !!state.model?.shared || ['running', 'queued'].includes(state.compile?.phase ?? '');
  compile.title = !state.trusted ? t('Trust the workspace to run gh aw.', 'gh awの実行にはワークスペースの信頼が必要です。') : '';
  drawTabs(); drawGraph(); drawForm(); results.replaceChildren(element('h2', t('Check result', '確認結果')));
  results.append(element('p', localMessage(state.compile?.message ?? state.status)));
  if (state.compile?.record) results.append(element('p', `${state.compile.record.output}\ngh aw ${state.compile.record.version} · ${state.compile.record.time}`, 'hint'));
  for (const issue of state.compile?.issues ?? []) results.append(element('p', `${issue.severity}: ${issue.message}`, 'diagnostic'));
  results.append(element('p', t('Ctrl+S saves Markdown only. Compilation can update lock YAML and auxiliary repository files. Compile success does not mean the workflow has run.', 'Ctrl+SはMarkdownだけを保存します。コンパイルではlock YAMLとリポジトリの補助ファイルを更新する場合があります。コンパイル成功はWorkflowの実行成功を意味しません。'), 'hint'));
}
window.addEventListener('message', event => {
  const message = event.data;
  if (message?.type === 'editComplete') { setEditBusy(false); return; }
  if (message?.type === 'selection' && message.uri === uri && message.version === state?.version && !pending) {
    if (mode === 'overview') return;
    selected = message.group; mode = message.selection?.type === 'instruction' ? 'instructions' : message.selection ? 'flow' : 'settings';
    flowSelection = message.selection; drawTabs(); drawGraph(); drawForm(); return;
  }
  if (message?.type === 'error') { setEditBusy(false); alerts.textContent = localMessage(String(message.message)); return; }
  if (message?.type !== 'state' || message.uri !== uri) return;
  const sameVersion = state?.version === message.version;
  const languageChanged = state?.language !== message.language || state?.languageSetting !== message.languageSetting;
  if (pending && sameVersion && !languageChanged) { state = message; return; }
  // A UI-language change must not discard unapplied forms or rewrite Markdown.
  const keepDraft = pending && sameVersion && languageChanged;
  const drafts = keepDraft ? Array.from(app.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select')).map(input => ({ value: input.value, checked: input instanceof HTMLInputElement ? input.checked : undefined, start: input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement ? input.selectionStart : null, end: input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement ? input.selectionEnd : null })) : [];
  const focus = document.activeElement?.id;
  japanese = message.language === 'ja'; document.documentElement.lang = japanese ? 'ja' : 'en';
  if (pending && !keepDraft) alerts.textContent = t('The source changed. Review the refreshed form before applying.', 'ソースが変更されました。更新されたフォームを確認してから適用してください。');
  else alerts.textContent = '';
  pending = keepDraft; state = message; render();
  if (keepDraft) Array.from(app.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select')).forEach((input, index) => {
    const draft = drafts[index]; if (!draft) return; input.value = draft.value;
    if (input instanceof HTMLInputElement && draft.checked !== undefined) input.checked = draft.checked;
    if ((input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) && draft.start !== null && draft.end !== null) input.setSelectionRange(draft.start, draft.end);
  });
  updateVisibility();
  if (focus) document.getElementById(focus)?.focus();
});
send('ready');

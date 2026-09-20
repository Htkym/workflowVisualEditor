import * as vscode from 'vscode';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseWorkflow, patchField, fieldModels, advancedSettings, readField, sourceOffset, type Parsed } from './core/document';
import { fields, groups, validValue, type Value } from './core/fields';
import { templates, templateText, validName } from './core/templates';
import { hash, inside, safePath, samePath, snapshotDependencies, importReferences, resolveImport } from './core/dependencies';
import { Compiler } from './vscode/compiler';
import { flowModel, sourceContext, generatedGraph, planFlowEdit, validFlowEdit, type FlowEdit, type FlowModel, type JobGraph } from './core/flow';

const viewType = 'ghAwDesigner.workflow';
const languageSetting = () => vscode.workspace.getConfiguration('ghAwDesigner').get<string>('language', 'auto');
const ja = () => languageSetting() === 'ja' || languageSetting() !== 'en' && vscode.env.language.toLowerCase().startsWith('ja');
const t = (en: string, jp: string) => ja() ? jp : en;
export async function repositoryRoot(uri: vscode.Uri): Promise<string> {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (uri.scheme !== 'file' || !folder) throw new Error(t('Open a local repository workspace.', 'ローカルリポジトリをワークスペースとして開いてください。'));
  let dir = path.dirname(uri.fsPath);
  while (inside(folder.uri.fsPath, dir)) {
    try { await access(path.join(dir, '.git')); return dir; } catch { /* find ancestor */ }
    const parent = path.dirname(dir); if (parent === dir) break; dir = parent;
  }
  throw new Error(t('No Git repository found in this workspace.', 'このワークスペースにGitリポジトリがありません。'));
}
export async function createWorkflow(root: string, name: string, text: string): Promise<vscode.TextDocument> {
  if (!validName(name)) throw new Error(t('Invalid workflow file name.', 'Workflowのファイル名が不正です。'));
  const file = path.join(root, '.github', 'workflows', name + '.md');
  await safePath(root, file); await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, { flag: 'wx' });
  return vscode.workspace.openTextDocument(vscode.Uri.file(file));
}
export function validMessage(message: unknown, uri: string): message is { type: string; uri: string; version?: number; field?: string; value?: Value; remove?: boolean; group?: string; ref?: string; edit?: FlowEdit; path?: (string | number)[]; instruction?: number } {
  if (!message || typeof message !== 'object') return false;
  const m = message as Record<string, unknown>;
  if (m.uri !== uri || typeof m.type !== 'string') return false;
  if (m.type === 'language') return m.value === 'ja' || m.value === 'en';
  if (m.type === 'flow') return Number.isSafeInteger(m.version) && validFlowEdit(m.edit);
  if (m.type === 'configSource') return Number.isSafeInteger(m.version) && Array.isArray(m.path) && m.path.length > 0 && m.path.length <= 20 && m.path.every(key => typeof key === 'string' && key.length <= 4096);
  if (m.type === 'flowSource') return Number.isSafeInteger(m.version) && (Number.isSafeInteger(m.instruction) && Number(m.instruction) >= 0 || Array.isArray(m.path) && m.path.length <= 5 && ['jobs', 'steps', 'post-steps'].includes(m.path[0]) && m.path.every(x => typeof x === 'string' && /^[A-Za-z_][A-Za-z0-9_-]{0,79}$/.test(x) || Number.isSafeInteger(x) && x >= 0));
  if (['ready', 'compile', 'source'].includes(m.type)) return m.group === undefined || typeof m.group === 'string' && groups.some(g => g.id === m.group);
  if (m.type === 'import') return typeof m.ref === 'string' && m.ref.length <= 4096;
  if (m.type !== 'edit' || !Number.isSafeInteger(m.version) || typeof m.field !== 'string' || m.remove !== undefined && typeof m.remove !== 'boolean') return false;
  const f = fields.find(f => f.path.join('.') === m.field);
  return !!f && (m.remove === true || validValue(f, m.value));
}
export async function applyFlowEdit(doc: vscode.TextDocument, message: unknown): Promise<boolean> {
  if (!validMessage(message, doc.uri.toString()) || message.type !== 'flow') throw new Error('Invalid flow message');
  if (message.version !== doc.version) return false;
  const patch = planFlowEdit(doc.getText(), message.edit!);
  const edit = new vscode.WorkspaceEdit(); edit.replace(doc.uri, new vscode.Range(doc.positionAt(patch.start), doc.positionAt(patch.end)), patch.text);
  const applied = await vscode.workspace.applyEdit(edit);
  if (applied) revealEdit(doc, patch.start, patch.text.length);
  return applied;
}
export async function applyFormEdit(doc: vscode.TextDocument, message: unknown): Promise<boolean> {
  if (!validMessage(message, doc.uri.toString()) || message.type !== 'edit') throw new Error('Invalid editor message');
  if (message.version !== doc.version) return false;
  const f = fields.find(f => f.path.join('.') === message.field)!;
  const patch = patchField(doc.getText(), f, message.value ?? null, message.remove || f.kind === 'presence' && message.value === false);
  if (patch.start === patch.end && !patch.text) return true;
  // Validate the complete candidate before applying the smallest source edit.
  const candidate = parseWorkflow(doc.getText().slice(0, patch.start) + patch.text + doc.getText().slice(patch.end));
  if (!message.remove && JSON.stringify(readField(candidate, f)) !== JSON.stringify(message.value)) throw new Error(t('This YAML form requires source editing.', 'このYAML形式はソースで編集してください。'));
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, new vscode.Range(doc.positionAt(patch.start), doc.positionAt(patch.end)), patch.text);
  const applied = await vscode.workspace.applyEdit(edit);
  if (applied) revealEdit(doc, patch.start, patch.text.length);
  return applied;
}
function revealEdit(doc: vscode.TextDocument, start: number, length: number) {
  for (const editor of vscode.window.visibleTextEditors) if (editor.document === doc)
    editor.revealRange(new vscode.Range(doc.positionAt(start), doc.positionAt(start + length)), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

export function activate(context: vscode.ExtensionContext) {
  const compiler = new Compiler(context); context.subscriptions.push(compiler);
  const views = new Map<vscode.WebviewPanel, vscode.TextDocument>();
  const readonly = new Map<string, string>();
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('gh-aw-output', { provideTextDocumentContent: uri => readonly.get(uri.toString()) ?? '' }));
  let active: vscode.TextDocument | undefined;
  const target = async (uri?: vscode.Uri) => {
    const sourceForLock = (candidate: vscode.Uri) => /\.lock\.yml$/i.test(candidate.fsPath) ? vscode.Uri.file(candidate.fsPath.replace(/\.lock\.yml$/i, '.md')) : candidate;
    if (uri instanceof vscode.Uri) return vscode.workspace.openTextDocument(sourceForLock(uri));
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (tab instanceof vscode.TabInputCustom && tab.viewType === viewType) return vscode.workspace.openTextDocument(tab.uri);
    const text = vscode.window.activeTextEditor?.document;
    if (text && /\.md$/i.test(text.uri.fsPath)) return text;
    if (text && /\.lock\.yml$/i.test(text.uri.fsPath)) return vscode.workspace.openTextDocument(sourceForLock(text.uri));
    if (active && !active.isClosed) return active;
    throw new Error(t('Select a Markdown workflow.', 'MarkdownのWorkflowを選択してください。'));
  };
  const showSource = async (doc: vscode.TextDocument, group?: string, explicitOffset?: number) => {
    let offset = explicitOffset ?? 0;
    try { if (explicitOffset === undefined) offset = sourceOffset(parseWorkflow(doc.getText()), group ?? 'metadata'); } catch { /* open invalid source at top */ }
    const position = doc.positionAt(offset);
    const existing = vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === doc.uri.toString());
    const column = existing?.viewColumn ?? Math.min(vscode.window.tabGroups.activeTabGroup.viewColumn + 1, vscode.ViewColumn.Nine) as vscode.ViewColumn;
    await vscode.commands.executeCommand('vscode.openWith', doc.uri, 'default', { viewColumn: column });
    const editor = await vscode.window.showTextDocument(doc, { viewColumn: column, selection: new vscode.Range(position, position), preview: false });
    editor.revealRange(new vscode.Range(position, position));
  };
  const openDesigner = async (doc: vscode.TextDocument) => {
    const existing = [...views].find(([, document]) => document.uri.toString() === doc.uri.toString());
    if (existing) { existing[0].reveal(existing[0].viewColumn); await showSource(doc); existing[0].reveal(existing[0].viewColumn); return; }
    const source = vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === doc.uri.toString());
    if (source) {
      await vscode.commands.executeCommand('vscode.openWith', doc.uri, viewType, { viewColumn: Math.min((source.viewColumn ?? 1) + 1, vscode.ViewColumn.Nine), preview: false });
    } else {
      await vscode.commands.executeCommand('vscode.openWith', doc.uri, viewType, { preview: false });
      const panel = [...views].find(([, document]) => document.uri.toString() === doc.uri.toString())?.[0];
      await showSource(doc); panel?.reveal(panel.viewColumn);
    }
  };
  const openReadonly = async (name: string, text: string) => {
    const uri = vscode.Uri.from({ scheme: 'gh-aw-output', path: '/' + name + '.yml', query: randomBytes(8).toString('hex') });
    readonly.set(uri.toString(), text);
    const doc = await vscode.workspace.openTextDocument(uri); await vscode.languages.setTextDocumentLanguage(doc, 'yaml'); return uri;
  };
  const openGenerated = async (doc: vscode.TextDocument) => {
    if (parseWorkflow(doc.getText()).shared) throw new Error(t('Shared components have no standalone output.', '共有コンポーネントに単独の生成物はありません。'));
    const result = await compiler.generated(doc);
    if (result) await vscode.window.showTextDocument(await openReadonly(path.basename(result.file), result.text), { preview: false });
  };
  const newWorkflow = async () => {
    const folders = vscode.workspace.workspaceFolders?.filter(f => f.uri.scheme === 'file');
    if (!folders?.length) throw new Error(t('Open a local repository first.', 'ローカルリポジトリを開いてください。'));
    const folder = folders.length === 1 ? folders[0] : (await vscode.window.showQuickPick(folders.map(f => ({ label: f.name, description: f.uri.fsPath, folder: f }))))?.folder;
    if (!folder) return;
    const root = await repositoryRoot(vscode.Uri.joinPath(folder.uri, 'workflow.md'));
    const options = [...templates.map(item => ({ label: item.label[ja() ? 1 : 0], id: item.id as string })), { label: t('Duplicate an existing document', '既存文書を複製'), id: 'duplicate' }];
    const template = await vscode.window.showQuickPick(options); if (!template) return;
    let duplicate: string | undefined;
    if (template.id === 'duplicate') {
      const chosen = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { Markdown: ['md'] } }); if (!chosen?.[0]) return;
      duplicate = (await vscode.workspace.openTextDocument(chosen[0])).getText();
    }
    const name = await vscode.window.showInputBox({ prompt: t('Workflow file name (without .md)', 'Workflowのファイル名（.mdは不要）'), validateInput: value => validName(value) ? undefined : t('Use a valid Windows file name, without .md.', 'Windowsで有効なファイル名を、.mdを付けずに入力してください。') });
    if (!name) return;
    const doc = await createWorkflow(root, name, duplicate ?? templateText(template.id, name));
    await openDesigner(doc);
  };
  const guard = <A extends unknown[]>(action: (...args: A) => Promise<unknown>) => async (...args: A) => { try { return await action(...args); } catch (error) { compiler.output.appendLine(String(error)); await vscode.window.showErrorMessage((error as Error).message); } };
  for (const [name, action] of Object.entries({
    newWorkflow,
    openDesigner: async (uri?: vscode.Uri) => openDesigner(await target(uri)),
    openSourceBeside: async (uri?: vscode.Uri) => showSource(await target(uri)),
    saveAndCompile: async (uri?: vscode.Uri) => { const doc = await target(uri); await compiler.compile(doc, await repositoryRoot(doc.uri)); },
    openGenerated: async (uri?: vscode.Uri) => openGenerated(await target(uri)),
    checkEnvironment: async () => { const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath; if (!root) throw new Error(t('Open a workspace.', 'ワークスペースを開いてください。')); await compiler.environment(root); }
  })) context.subscriptions.push(vscode.commands.registerCommand('ghAwDesigner.' + name, guard(action)));

  const provider: vscode.CustomTextEditorProvider = {
    async resolveCustomTextEditor(doc, panel) {
      active = doc; views.set(panel, doc);
      const resources = vscode.Uri.joinPath(context.extensionUri, 'dist');
      panel.webview.options = { enableScripts: true, localResourceRoots: [resources] };
      const nonce = randomBytes(24).toString('base64');
      const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(resources, 'webview.js'));
      const css = panel.webview.asWebviewUri(vscode.Uri.joinPath(resources, 'webview.css'));
      panel.webview.html = `<!doctype html><html lang="${ja() ? 'ja' : 'en'}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${panel.webview.cspSource};"><link rel="stylesheet" href="${css}"><title>Workflow Designer</title></head><body data-uri="${escapeAttribute(doc.uri.toString())}"><main id="app"></main><script nonce="${nonce}" src="${script}"></script></body></html>`;
      let timer: ReturnType<typeof setTimeout> | undefined, generation = 0, disposed = false;
      let lastGood: { data: Parsed['data']; fields: ReturnType<typeof fieldModels>; advanced: ReturnType<typeof advancedSettings>; body: string; shared: boolean; imports: string[]; flow: FlowModel } | undefined;
      const update = async () => {
        const current = ++generation, version = doc.version, started = performance.now();
        let error = '', status = '', dependencies: { path: string; dirty: boolean }[] = [];
        let generated: (JobGraph & { label: string }) | undefined, graphError = '';
        try {
          const parsed = parseWorkflow(doc.getText());
          lastGood = { data: parsed.data, fields: fieldModels(parsed, doc.getText()), advanced: advancedSettings(parsed), body: parsed.body, shared: parsed.shared, imports: importReferences(doc.getText()), flow: flowModel(doc.getText(), parsed) };
        } catch (e) { error = (e as Error).message; }
        const model = lastGood;
        try {
          const root = await repositoryRoot(doc.uri);
          await compiler.observe(doc.uri);
          await compiler.observeRepository(root);
          if (!error) status = await compiler.status(doc, root);
          const deps = await snapshotDependencies(root, doc.uri.fsPath, file => compiler.readCurrent(file));
          dependencies = Object.keys(deps.hashes).filter(p => !samePath(p, doc.uri.fsPath)).map(p => ({ path: p, dirty: vscode.workspace.textDocuments.some(d => samePath(d.uri.fsPath, p) && d.isDirty) }));
          if (!model?.shared) {
            try {
              const record = compiler.record(doc.uri);
              const output = await compiler.preferredOutput(doc);
              if (!output) throw Object.assign(new Error('No output'), { code: 'ENOENT' });
              const parsed = !error ? parseWorkflow(doc.getText()) : undefined;
              const source = record && output.verified && parsed && hash(parsed.yaml) === record.config ? parsed : undefined;
              generated = { ...generatedGraph(output.text, source), label: output.label };
            }
            catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') graphError = (e as Error).message; }
          }
        } catch (e) { status = (e as Error).message; }
        if (disposed || current !== generation || version !== doc.version) return;
        await panel.webview.postMessage({ type: 'state', uri: doc.uri.toString(), version, language: ja() ? 'ja' : 'en', languageSetting: ja() ? 'ja' : 'en', model, generated, graphError, error, status, dependencies, dirty: doc.isDirty, trusted: vscode.workspace.isTrusted, compile: compiler.states.get(doc.uri.toString()) ?? { phase: 'idle', record: compiler.record(doc.uri) }, parseMs: performance.now() - started });
      };
      const schedule = () => { clearTimeout(timer); timer = setTimeout(() => void update().catch(e => compiler.output.appendLine(String(e))), 150); };
      const watcher = vscode.workspace.createFileSystemWatcher('**/{*.md,*.yml,*.yaml,*.json,.gitattributes}');
      const disposables = [
        vscode.window.onDidChangeTextEditorSelection(event => {
          if (event.textEditor.document !== doc || event.kind === undefined) return;
          try {
            const location = sourceContext(doc.getText(), doc.offsetAt(event.selections[0].active));
            void panel.webview.postMessage({ type: 'selection', uri: doc.uri.toString(), version: doc.version, ...location });
          } catch { /* Keep the last valid context while syntax is incomplete. */ }
        }),
        vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('ghAwDesigner.language')) schedule(); }),
        vscode.workspace.onDidChangeTextDocument(schedule), vscode.workspace.onDidSaveTextDocument(schedule), compiler.changed.event(schedule), vscode.workspace.onDidGrantWorkspaceTrust(schedule),
        watcher, watcher.onDidChange(schedule), watcher.onDidCreate(schedule), watcher.onDidDelete(schedule),
        panel.onDidChangeViewState(() => { if (panel.active) active = doc; }),
        panel.webview.onDidReceiveMessage(async message => {
          if (!validMessage(message, doc.uri.toString())) { compiler.output.appendLine('Rejected invalid webview message'); await panel.webview.postMessage({ type: 'error', message: t('Invalid edit. Check the job ID and values; compiler job IDs are reserved.', '編集内容が不正です。ジョブIDや値を確認してください。CLIが生成するジョブIDは使用できません。') }); return; }
          try {
            if (message.type === 'ready') await update();
            else if (message.type === 'language') await vscode.workspace.getConfiguration('ghAwDesigner').update('language', message.value, vscode.ConfigurationTarget.Global);
            else if (message.type === 'flow') { if (!await applyFlowEdit(doc, message)) await panel.webview.postMessage({ type: 'error', message: t('The document changed. Review the refreshed flow and retry.', '文書が変更されました。更新されたフローを確認して再適用してください。') }); await update(); await panel.webview.postMessage({ type: 'editComplete' }); }
            else if (message.type === 'flowSource') {
              if (message.version !== doc.version) { await update(); return; }
              const p = parseWorkflow(doc.getText());
              const node = message.path ? p.doc.getIn(message.path, true) as { range?: number[] } | undefined : undefined;
              const offset = message.instruction === undefined ? p.start + (node?.range?.[0] ?? 0) : flowModel(doc.getText(), p).instructions[message.instruction]?.start;
              if (offset !== undefined) await showSource(doc, undefined, offset);
            }
            else if (message.type === 'configSource') {
              if (message.version !== doc.version) { await update(); return; }
              const parsed = parseWorkflow(doc.getText()), key = JSON.stringify(message.path);
              const advanced = advancedSettings(parsed).find(item => JSON.stringify(item.path) === key);
              if (!advanced && !fields.some(field => JSON.stringify(field.path) === key)) throw new Error('Unknown setting');
              const node = parsed.doc.getIn(message.path!, true) as { range?: number[] } | undefined;
              await showSource(doc, undefined, advanced?.offset ?? parsed.start + (node?.range?.[0] ?? 0));
            }
            else if (message.type === 'edit') { if (!await applyFormEdit(doc, message)) await panel.webview.postMessage({ type: 'error', message: t('The document changed. Review the refreshed form and apply again.', '文書が変更されました。更新されたフォームを確認して再適用してください。') }); await update(); await panel.webview.postMessage({ type: 'editComplete' }); }
            else if (message.type === 'source') await showSource(doc, message.group);
            else if (message.type === 'compile') await compiler.compile(doc, await repositoryRoot(doc.uri));
            else if (message.type === 'import') {
              const ref = message.ref!;
              if (!importReferences(doc.getText()).includes(ref)) throw new Error('Unknown import');
              const root = await repositoryRoot(doc.uri), file = resolveImport(root, doc.uri.fsPath, ref);
              if (!file) throw new Error(t('Remote imports are resolved by the CLI.', 'リモート参照の解決はCLIに委ねます。'));
              await safePath(root, file); await vscode.window.showTextDocument(vscode.Uri.file(file), { viewColumn: vscode.ViewColumn.Beside });
            }
          } catch (error) { await update(); await panel.webview.postMessage({ type: 'error', message: (error as Error).message }); compiler.output.appendLine(String(error)); }
        })
      ];
      panel.onDidDispose(() => { disposed = true; clearTimeout(timer); views.delete(panel); disposables.forEach(d => d.dispose()); });
    }
  };
  context.subscriptions.push(vscode.window.registerCustomEditorProvider(viewType, provider, { supportsMultipleEditorsPerDocument: true, webviewOptions: { retainContextWhenHidden: true } }));
  return { compiler, createWorkflow, applyFormEdit, applyFlowEdit, viewCount: () => views.size };
}
function escapeAttribute(value: string) { return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }

import * as vscode from 'vscode';
import path from 'node:path';
import { readFile, mkdir, writeFile, readdir, lstat } from 'node:fs/promises';
import { checkCli, run, parseDiagnostics, RepositoryQueue, type Issue } from '../compiler/cli';
import { hash, inside, safePath, samePath, pathKey, snapshotDependencies, sameInputs, type DependencySnapshot } from '../core/dependencies';
import { parseWorkflow } from '../core/document';

export interface CompileRecord { version: string; source: string; inputs: DependencySnapshot; config: string; body: string; output: string; outputHash: string; backup: string; time: string; }
export interface CompileState { phase: 'idle' | 'queued' | 'running' | 'success' | 'failed' | 'cancelled'; message?: string; issues?: Issue[]; record?: CompileRecord; }
export const lockPath = (source: string) => source.replace(/\.md$/i, '.lock.yml');
const disk = async (file: string) => { try { return await readFile(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; } };
export class Compiler implements vscode.Disposable {
  readonly states = new Map<string, CompileState>();
  readonly changed = new vscode.EventEmitter<void>();
  readonly output = vscode.window.createOutputChannel('GitHub Agentic Workflows');
  readonly diagnostics = vscode.languages.createDiagnosticCollection('gh-aw');
  private readonly queue = new RepositoryQueue();
  private readonly observed = new Map<string, string | undefined>();
  private readonly auxiliary = new Map<string, Record<string, string>>();
  private readonly controllers = new Set<AbortController>();
  private readonly diagnosticFiles = new Map<string, vscode.Uri[]>();
  private cliVersion?: string;
  private readonly textChanges: vscode.Disposable;
  constructor(private readonly context: vscode.ExtensionContext) { this.textChanges = vscode.workspace.onDidChangeTextDocument(e => { if (e.contentChanges.length) this.diagnostics.delete(e.document.uri); }); }
  dispose() { for (const controller of this.controllers) controller.abort(); this.textChanges.dispose(); this.changed.dispose(); this.output.dispose(); this.diagnostics.dispose(); }
  record(uri: vscode.Uri) { return this.context.workspaceState.get<CompileRecord>('compile:' + uri.toString()); }
  private set(uri: vscode.Uri, state: CompileState) { this.states.set(uri.toString(), state); this.changed.fire(); }
  async observe(uri: vscode.Uri) {
    const output = lockPath(uri.fsPath);
    if (!this.observed.has(output)) { const text = await disk(output); this.observed.set(output, text === undefined ? undefined : hash(text)); }
  }
  async observeRepository(root: string) { if (!this.auxiliary.has(pathKey(root))) this.auxiliary.set(pathKey(root), await auxiliaryHashes(root)); }
  async status(doc: vscode.TextDocument, root: string): Promise<string> {
    const state = this.states.get(doc.uri.toString());
    if (state && ['running', 'queued', 'failed', 'cancelled'].includes(state.phase)) return `${state.phase}: ${state.message ?? ''}`;
    const parsed = parseWorkflow(doc.getText());
    if (parsed.shared) return 'Shared component; no standalone output / 共有コンポーネント・単独の生成物はありません';
    const record = this.record(doc.uri);
    const output = await disk(lockPath(doc.uri.fsPath));
    if (!record) return output !== undefined ? 'Existing output: correspondence unverified / 既存生成物・対応状態未確認' : 'Not compiled / 未コンパイル';
    if (output === undefined) return 'Generated .lock.yml missing / 生成物.lock.ymlがありません';
    if (hash(output) !== record.outputHash) return 'Lock YAML exists; differs from extension record (unverified) / lock YAMLあり・拡張の成功記録とは不一致（対応未確認）';
    if (this.cliVersion && record.version !== this.cliVersion) return 'Compiler version changed; compile again / CLIの版が変わりました・再生成待ち';
    if (hash(parsed.yaml) !== record.config) return 'Configuration changed; compile again / 設定変更あり・再生成待ち';
    const inputs = await snapshotDependencies(root, doc.uri.fsPath, file => this.readCurrent(file));
    const previous = { ...record.inputs, hashes: { ...record.inputs.hashes, [pathKey(doc.uri.fsPath)]: inputs.hashes[pathKey(doc.uri.fsPath)] } };
    if (!sameInputs(previous, inputs)) return 'Dependencies changed / 依存ファイルの変更は未反映';
    if (hash(parsed.body) !== record.body) return 'Instructions updated; configuration unchanged / 本文更新済み・生成設定は変更なし';
    return inputs.remote.length ? 'Local inputs match; remote imports not verified / ローカル入力は一致・リモート参照は未確認' : 'Compile succeeded; saved output matches / コンパイル成功・生成物保存済み';
  }
  readCurrent(file: string): Promise<string> {
    const doc = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && samePath(d.uri.fsPath, file));
    return doc?.isDirty ? Promise.resolve(doc.getText()) : readFile(file, 'utf8');
  }
  async environment(root: string) {
    if (!vscode.workspace.isTrusted) throw new Error('Workspace Trust required; no commands executed / 未信頼のため外部コマンドは実行しません');
    const cli = await checkCli(root);
    if (cli.available) this.cliVersion = cli.version;
    this.output.appendLine(`${cli.gh}\n${cli.details}\nTrusted workspace / 信頼済みワークスペース`);
    this.output.show(true);
    return cli;
  }
  async compile(doc: vscode.TextDocument, root: string) {
    if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before compilation / コンパイルにはワークスペースの信頼が必要です');
    const source = doc.uri.fsPath;
    if (doc.uri.scheme !== 'file' || !samePath(path.dirname(source), path.join(root, '.github', 'workflows')) || !source.endsWith('.md')) throw new Error('Compile .github/workflows/<name>.md in a local repository / ローカルリポジトリの.github/workflows/<name>.mdを選んでください');
    if (parseWorkflow(doc.getText()).shared) throw new Error('Shared components are compiled through their importing workflow / 共有コンポーネントは参照元のWorkflowからコンパイルしてください');
    await safePath(root, source);
    await this.observe(doc.uri);
    await this.observeRepository(root);
    const controller = new AbortController(); this.controllers.add(controller);
    this.set(doc.uri, { phase: 'queued' });
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'gh aw: Save and Compile / 保存してコンパイル', cancellable: true }, async (_progress, token) => {
        const cancel = token.onCancellationRequested(() => controller.abort());
        try { await this.queue.enqueue(root, () => this.execute(doc, root, controller.signal), controller.signal); }
        finally { cancel.dispose(); }
      });
    } catch (error) {
      this.set(doc.uri, { phase: controller.signal.aborted ? 'cancelled' : 'failed', message: String((error as Error).message) });
      throw error;
    } finally { this.controllers.delete(controller); }
  }
  private async execute(doc: vscode.TextDocument, root: string, signal: AbortSignal) {
    if (!vscode.workspace.isTrusted) throw new Error('Workspace is not trusted / ワークスペースが未信頼です');
    const source = doc.uri.fsPath, output = lockPath(source);
    const cli = await checkCli(root);
    if (!cli.available) throw new Error(`Install or repair gh aw; current / 現在: ${cli.details}. See README / READMEを参照してください`);
    this.cliVersion = cli.version;
    let deps = await snapshotDependencies(root, source, file => this.readCurrent(file));
    await this.checkConflicts(root, output, deps);
    const dirty = vscode.workspace.textDocuments.filter(d => d.isDirty && d !== doc && Object.keys(deps.hashes).some(file => samePath(file, d.uri.fsPath)));
    if (dirty.length) {
      const choice = await vscode.window.showWarningMessage(`Save dependencies? / 依存ファイルを保存しますか？\n${dirty.map(d => d.uri.fsPath).join('\n')}`, { modal: true }, 'Save / 保存');
      if (choice !== 'Save / 保存') throw new Error('Cancelled: unsaved dependencies / 未保存の依存があるため中止しました');
      for (const dep of dirty) if (!await dep.save()) throw new Error(`Could not save / 保存できません: ${dep.uri.fsPath}`);
    }
    if (!await doc.save()) throw new Error('Could not save source / ソースを保存できません');
    const saved = await readFile(source, 'utf8');
    if (doc.isDirty || saved.replace(/^\uFEFF/, '') !== doc.getText().replace(/^\uFEFF/, '')) throw new Error('Source changed while saving / 保存中にソースが変更されました');
    const parsed = parseWorkflow(saved);
    if (parsed.shared) throw new Error('No standalone workflow / 単独のWorkflowではありません');
    deps = await snapshotDependencies(root, source);
    if (!sameInputs(deps, await snapshotDependencies(root, source, file => this.readCurrent(file)))) throw new Error('Dependencies changed during save / 保存中に依存が変更されました');
    await this.checkConflicts(root, output, deps);
    const previousOutput = await disk(output);
    const storage = this.context.globalStorageUri.fsPath;
    await mkdir(storage, { recursive: true });
    if (previousOutput !== undefined) await writeFile(path.join(storage, `${hash(doc.uri.toString())}-before.yml`), previousOutput);
    const before = { source, inputs: deps, version: cli.version, outputHash: previousOutput === undefined ? null : hash(previousOutput), time: new Date().toISOString() };
    await this.context.workspaceState.update('attempt:' + doc.uri.toString(), before);
    if (signal.aborted) throw new Error('Cancelled / 中止しました');
    this.set(doc.uri, { phase: 'running' });
    for (const uri of this.diagnosticFiles.get(doc.uri.toString()) ?? [doc.uri]) this.diagnostics.delete(uri);
    const result = await run(cli.executable, ['aw', 'compile', '--json', '--no-check-update', source], root, signal);
    // Changes produced by this invocation become the next preflight baseline even
    // on failure. They are not rolled back or classified as successful output.
    this.auxiliary.set(pathKey(root), await auxiliaryHashes(root));
    const currentOutput = await disk(output);
    this.observed.set(output, currentOutput === undefined ? undefined : hash(currentOutput));
    this.output.appendLine(`\n${source}\n${result.stdout}\n${result.stderr}`);
    if (result.cancelled) { this.set(doc.uri, { phase: 'cancelled' }); return; }
    const diagnostics = parseDiagnostics(result.stdout);
    if (result.code === 0 && diagnostics.valid && !diagnostics.outputs.some(file => samePath(path.resolve(root, file), output))) throw new Error('Compiler did not confirm the expected output / CLIが対象の生成先を確認できませんでした');
    this.diagnosticFiles.set(doc.uri.toString(), await this.publishDiagnostics(root, deps, diagnostics.issues));
    const generated = await disk(output);
    if (result.code !== 0 || !diagnostics.valid || !generated) {
      this.set(doc.uri, { phase: 'failed', message: result.stderr || 'Compiler rejected the workflow / コンパイルに失敗しました', issues: diagnostics.issues });
      this.output.show(true); return;
    }
    const backup = path.join(storage, `${hash(doc.uri.toString())}-success.yml`);
    await writeFile(backup, generated);
    // Compiler-owned caches may legitimately change. Record their final content, but
    // retain the exact pre-run source/import hashes to detect edits during compilation.
    const after = await snapshotDependencies(root, source);
    for (const file of Object.keys(after.hashes)) if (isCompilerCache(root, file)) deps.hashes[file] = after.hashes[file];
    const record: CompileRecord = { source, inputs: deps, config: hash(parsed.yaml), body: hash(parsed.body), version: cli.version ?? 'unknown', output, outputHash: hash(generated), backup, time: new Date().toISOString() };
    await this.context.workspaceState.update('compile:' + doc.uri.toString(), record);
    this.observed.set(output, record.outputHash);
    const current = await snapshotDependencies(root, source, file => this.readCurrent(file));
    this.set(doc.uri, { phase: 'success', record, issues: diagnostics.issues, message: sameInputs(deps, current) ? undefined : 'Edited during compilation; result is for previous inputs / コンパイル中の編集は未反映です' });
  }
  private async checkConflicts(root: string, output: string, inputs: DependencySnapshot) {
    await safePath(root, output);
    // All compiler-controlled directories are checked, including advanced workflows'
    // maintenance/dependabot outputs. No recursive write is performed by this check.
    for (const directory of ['.github/workflows', '.github/aw', '.github/dependabot']) await rejectLinks(path.join(root, directory));
    await safePath(root, path.join(root, '.gitattributes'));
    await safePath(root, path.join(root, '.github/dependabot.yml'));
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme !== 'file' || !doc.isDirty || !inside(root, doc.uri.fsPath)) continue;
      const rel = path.relative(root, doc.uri.fsPath).replaceAll('\\', '/');
      const outputFile = samePath(doc.uri.fsPath, output) || rel === '.gitattributes' || rel === '.github/dependabot.yml' || isCompilerCache(root, doc.uri.fsPath) || /\.lock\.yml$|(?:^|\/)(?:package(?:-lock)?\.json|agentics-maintenance[^/]*\.yml|agentic_(?:slash_)?commands\.yml)$/.test(rel);
      const inputOnly = Object.hasOwn(inputs.hashes, pathKey(doc.uri.fsPath)) && !outputFile;
      if (inputOnly) continue;
      if (samePath(doc.uri.fsPath, output) || rel === '.gitattributes' || rel.startsWith('.github/') && !rel.endsWith('.md')) throw new Error(`Unsaved output or auxiliary file / 生成物・補助ファイルが未保存です: ${doc.uri.fsPath}`);
    }
    const existing = await disk(output);
    if (existing?.match(/^(<{7}|={7}|>{7})/m)) throw new Error('Merge conflict in generated file / 生成物に競合マーカーがあります');
    const expected = this.observed.get(output);
    const actual = existing === undefined ? undefined : hash(existing);
    if (expected !== actual) throw new Error('Generated output changed externally. Review it, then reopen the workspace before compiling / 生成物が外部で変更されました。差分を確認してワークスペースを開き直してください');
    const baseline = this.auxiliary.get(pathKey(root)), current = await auxiliaryHashes(root);
    if (baseline && JSON.stringify(baseline) !== JSON.stringify(current)) throw new Error('Compiler auxiliary files changed externally. Review changes and reopen the workspace / CLIの補助ファイルが外部で変更されました。確認後にワークスペースを開き直してください');
    for (const file of Object.keys(inputs.hashes)) { if (hasConflict(await this.readCurrent(file))) throw new Error(`Unresolved merge conflict / 未解決の競合があります: ${file}`); }
  }
  private async publishDiagnostics(root: string, deps: DependencySnapshot, issues: Issue[]) {
    const grouped = new Map<string, vscode.Diagnostic[]>();
    for (const issue of issues) {
      if (!issue.file || !issue.line) continue;
      const file = pathKey(path.resolve(root, issue.file));
      if (!Object.hasOwn(deps.hashes, file)) continue;
      const doc = await vscode.workspace.openTextDocument(file);
      if (hash(doc.getText()) !== deps.hashes[file]) continue;
      if (issue.line > doc.lineCount) continue;
      const d = new vscode.Diagnostic(doc.lineAt(issue.line - 1).range, issue.message, issue.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
      d.source = 'gh aw'; grouped.set(file, [...(grouped.get(file) ?? []), d]);
    }
    for (const [file, diagnostics] of grouped) this.diagnostics.set(vscode.Uri.file(file), diagnostics);
    return [...grouped.keys()].map(file => vscode.Uri.file(file));
  }
  private async outputOptions(doc: vscode.TextDocument) {
    const record = this.record(doc.uri);
    const current = await disk(lockPath(doc.uri.fsPath));
    const currentMatches = !!record && (!this.cliVersion || record.version === this.cliVersion) && current !== undefined && hash(current) === record.outputHash;
    const options = [
      ...(current === undefined ? [] : [{ label: currentMatches ? 'Current .lock.yml (matches last success) / 現在の.lock.yml（最後の成功と一致）' : 'Existing .lock.yml (unverified) / 既存の.lock.yml（対応未確認）', file: lockPath(doc.uri.fsPath), verified: currentMatches }]),
      ...(record ? [{ label: 'Last successful output / 最後の正常生成物', file: record.backup, verified: !this.cliVersion || record.version === this.cliVersion }] : []),
      { label: 'Before compilation (unverified) / 実行前の退避（未確認）', file: path.join(this.context.globalStorageUri.fsPath, `${hash(doc.uri.toString())}-before.yml`), verified: false }
    ];
    const available = [];
    for (const option of options) { const text = await disk(option.file); if (text !== undefined) available.push({ ...option, text }); }
    return available;
  }
  async preferredOutput(doc: vscode.TextDocument) { return (await this.outputOptions(doc))[0]; }
  async generated(doc: vscode.TextDocument) {
    const available = await this.outputOptions(doc);
    if (!available.length) throw new Error(`No generated output for ${path.basename(doc.uri.fsPath)}; expected ${path.basename(lockPath(doc.uri.fsPath))} / ${path.basename(doc.uri.fsPath)}の生成物がありません。確認先: ${path.basename(lockPath(doc.uri.fsPath))}`);
    return available.length === 1 ? available[0] : vscode.window.showQuickPick(available, { placeHolder: 'Open read-only output / 読み取り専用で開く生成物' });
  }
}
async function auxiliaryHashes(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(dir: string) {
    await safePath(root, dir);
    try {
      for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`Compiler path contains a link: ${file}`);
        if (entry.isDirectory()) { if (entry.name !== 'node_modules') await walk(file); }
        else if ((!entry.name.endsWith('.md') && !entry.name.endsWith('.lock.yml') && !entry.name.endsWith('.invalid.yml') && !entry.name.endsWith('.json')) || ['actions-lock.json', 'package.json', 'package-lock.json'].includes(entry.name)) { const bytes = await readFile(file); if (hasConflict(bytes.toString('utf8'))) throw new Error(`Unresolved auxiliary merge conflict: ${file}`); result[pathKey(file)] = hash(bytes); }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  for (const rel of ['.github/workflows', '.github/aw']) await walk(path.join(root, rel));
  for (const rel of ['.gitattributes', '.github/dependabot.yml']) { const file = path.join(root, rel); await safePath(root, file); const value = await disk(file); if (value !== undefined) { if (hasConflict(value)) throw new Error(`Unresolved auxiliary merge conflict: ${file}`); result[pathKey(file)] = hash(value); } }
  return result;
}
function hasConflict(text: string) { return /^<<<<<<< /m.test(text) && /^=======\r?$/m.test(text) && /^>>>>>>> /m.test(text); }
function isCompilerCache(root: string, file: string) { return /^\.github\/aw\/.*lock.*\.json$/.test(path.relative(root, file).replaceAll('\\', '/')); }
async function rejectLinks(directory: string): Promise<void> {
  try {
    const info = await lstat(directory); if (info.isSymbolicLink()) throw new Error(`Compiler directory contains a link / コンパイル先にリンクがあります: ${directory}`);
    if (!info.isDirectory()) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error(`Compiler directory contains a link / コンパイル先にリンクがあります: ${entry.name}`);
      if (entry.isDirectory()) await rejectLinks(path.join(directory, entry.name));
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

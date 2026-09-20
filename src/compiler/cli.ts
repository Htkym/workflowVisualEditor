import { spawn } from 'node:child_process';
import path from 'node:path';
import { access } from 'node:fs/promises';
export interface ProcessResult { code: number; stdout: string; stderr: string; cancelled: boolean }
export async function findGh(): Promise<string> {
  // Never resolve a workspace-local executable or invoke a command shell.
  for (const folder of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(folder.replace(/^"|"$/g, ''))) continue;
    const file = path.join(folder.replace(/^"|"$/g, ''), process.platform === 'win32' ? 'gh.exe' : 'gh');
    try { await access(file); return file; } catch { /* next PATH entry */ }
  }
  throw new Error('GitHub CLI (gh) was not found on PATH / PATHにGitHub CLI (gh)がありません');
}
export function run(executable: string, args: string[], cwd: string, signal?: AbortSignal, timeoutMs = 180_000): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { resolve({ code: -1, stdout: '', stderr: '', cancelled: true }); return; }
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    let stdout = '', stderr = '', cancelled = false, failure: Error | undefined;
    const stop = () => {
      if (cancelled) return;
      cancelled = true;
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else child.kill('SIGKILL');
    };
    const timer = setTimeout(() => { failure = new Error('CLI timeout / CLIがタイムアウトしました'); stop(); }, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); };
    child.stdout.on('data', chunk => { stdout += chunk.toString(); if (stdout.length > 8_000_000) { failure = new Error('CLI output limit exceeded'); stop(); } });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); if (stderr.length > 8_000_000) { failure = new Error('CLI output limit exceeded'); stop(); } });
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', code => { cleanup(); if (failure) reject(failure); else resolve({ code: code ?? -1, stdout, stderr, cancelled }); });
  });
}
export async function checkCli(cwd: string) {
  const executable = await findGh();
  const gh = await run(executable, ['--version'], cwd, undefined, 15_000);
  const aw = await run(executable, ['aw', 'version'], cwd, undefined, 15_000);
  const version = /\bversion v?(\d+\.\d+\.\d+[^\s]*)/.exec(aw.stdout + aw.stderr)?.[1];
  return { executable, gh: gh.stdout.trim(), version, available: gh.code === 0 && aw.code === 0, details: aw.stdout + aw.stderr };
}
export interface Issue { message: string; type?: string; file?: string; line?: number; severity: 'error' | 'warning' }
export function parseDiagnostics(stdout: string): { valid: boolean; issues: Issue[]; outputs: string[] } {
  const data: unknown = JSON.parse(stdout);
  if (!Array.isArray(data) || data.length === 0) throw new Error('Missing compiler JSON results / CLIのJSON結果がありません');
  const issues: Issue[] = [];
  for (const result of data) {
    if (!result || typeof result !== 'object' || typeof result.valid !== 'boolean') throw new Error('Invalid compiler JSON / CLIのJSON形式が不正です');
    for (const severity of ['error', 'warning'] as const) {
      const list = result[severity === 'error' ? 'errors' : 'warnings'] ?? [];
      if (!Array.isArray(list)) throw new Error('Invalid diagnostic list');
      for (const issue of list) if (issue && typeof issue.message === 'string') issues.push({ message: issue.message, type: issue.type, file: typeof issue.file === 'string' ? issue.file : undefined, line: Number.isInteger(issue.line) && issue.line > 0 ? issue.line : undefined, severity });
    }
  }
  return { valid: data.every(x => x.valid), issues, outputs: data.flatMap(x => typeof x.compiled_file === 'string' ? [x.compiled_file] : []) };
}
export class RepositoryQueue {
  private readonly pending = new Map<string, Promise<unknown>>();
  async enqueue<T>(root: string, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const key = process.platform === 'win32' ? root.toLowerCase() : root;
    const previous = this.pending.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => { if (signal?.aborted) throw new Error('Cancelled / 中止しました'); return action(); });
    this.pending.set(key, next);
    try { return await next; } finally { if (this.pending.get(key) === next) this.pending.delete(key); }
  }
}

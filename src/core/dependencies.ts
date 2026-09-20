import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { parseWorkflow } from './document';
export const hash = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex');
export const samePath = (a: string, b: string) => path.relative(path.resolve(a), path.resolve(b)) === '';
export const pathKey = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
export const inside = (root: string, file: string) => { const rel = path.relative(root, file); return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
export async function safePath(root: string, file: string): Promise<void> {
  if (!inside(root, file)) throw new Error(`Outside repository / リポジトリの外です: ${file}`);
  let ancestor = file;
  while (true) {
    try {
      const resolved = await realpath(ancestor);
      if (!inside(await realpath(root), resolved)) throw new Error(`Link outside repository / リポジトリ外へのリンクです: ${file}`);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor); if (parent === ancestor) throw error; ancestor = parent;
    }
  }
}
export interface DependencySnapshot { hashes: Record<string, string>; remote: string[]; missing: string[] }
export function importReferences(text: string): string[] {
  let imports: unknown;
  try { imports = parseWorkflow(text).data.imports; } catch { imports = undefined; }
  if (imports && typeof imports === 'object' && !Array.isArray(imports)) imports = (imports as Record<string, unknown>).aw;
  const refs = Array.isArray(imports) ? imports.flatMap(item => typeof item === 'string' ? [item] : item && typeof item === 'object' ? [item.path ?? item.uses].filter((x): x is string => typeof x === 'string') : []) : [];
  // gh-aw also permits Markdown includes in instruction bodies.
  for (const match of text.matchAll(/^\s*(?:@(?:include|import)\??\s+(.+?)|\{\{#(?:runtime-import|import)\??\s*:?\s+(.+?)\}\})\s*$/gm)) refs.push((match[1] ?? match[2]).replace(/^['"]|['"]$/g, ''));
  return refs;
}
export function resolveImport(root: string, from: string, ref: string): string | undefined {
  if (/^[^/\s]+\/[^/\s]+\/.+@[^\s]+$/.test(ref) || /^https?:/.test(ref)) return undefined;
  const clean = ref.split('#')[0];
  if (!clean || clean.includes('${{')) return undefined;
  return path.resolve(clean.startsWith('.github/') || clean.startsWith('/') ? root : path.dirname(from), clean.replace(/^\//, ''));
}
export async function snapshotDependencies(root: string, source: string, read: (file: string) => Promise<string> = file => readFile(file, 'utf8')): Promise<DependencySnapshot> {
  const result: DependencySnapshot = { hashes: {}, remote: [], missing: [] };
  const seen = new Set<string>();
  async function walk(file: string) {
    const key = pathKey(file); if (seen.has(key)) return; seen.add(key);
    if (seen.size > 500) throw new Error('Too many local dependencies / ローカル依存が500件を超えています');
    await safePath(root, key);
    let text: string;
    try { text = await read(key); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; result.missing.push(key); return; }
    result.hashes[key] = hash(text);
    for (const ref of importReferences(text)) {
      const target = resolveImport(root, key, ref);
      if (target) await walk(target); else if (!result.remote.includes(ref)) result.remote.push(ref);
    }
  }
  await walk(source);
  // Repository configuration and lock caches affect compilation even when not imported.
  for (const rel of ['.github/workflows/aw.json', '.github/aw/actions-lock.json', 'aw.json']) {
    const file = path.join(root, rel); await safePath(root, file);
    try { if ((await stat(file)).isFile()) result.hashes[pathKey(file)] = hash(await read(file)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return result;
}
export const sameInputs = (a: DependencySnapshot, b: DependencySnapshot) => JSON.stringify(Object.entries(a.hashes).sort()) === JSON.stringify(Object.entries(b.hashes).sort()) && JSON.stringify(a.missing.sort()) === JSON.stringify(b.missing.sort()) && JSON.stringify(a.remote.sort()) === JSON.stringify(b.remote.sort());

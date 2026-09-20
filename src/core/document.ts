import { isAlias, isMap, isScalar, isSeq, parseDocument, stringify, visit, type Node, type YAMLMap } from 'yaml';
import { fields, type Field, type Group, type Value } from './fields';

export class SourceEditRequired extends Error {}
export interface Patch { start: number; end: number; text: string }
export function parseWorkflow(text: string) {
  const open = /^(?:\uFEFF)?---[ \t]*\r?\n/.exec(text);
  if (!open) throw new SourceEditRequired('Missing YAML frontmatter / YAML frontmatterがありません');
  const close = /^---[ \t]*\r?$/gm; close.lastIndex = open[0].length;
  const end = close.exec(text);
  if (!end) throw new SourceEditRequired('Unclosed frontmatter / frontmatterが閉じられていません');
  const start = open[0].length;
  const yaml = text.slice(start, end.index);
  const doc = parseDocument(yaml, { keepSourceTokens: true, uniqueKeys: true, strict: true });
  if (doc.errors.length) throw new SourceEditRequired(doc.errors.map(e => e.message).join('\n'));
  if (!isMap(doc.contents)) throw new SourceEditRequired('Frontmatter must be a mapping / frontmatterはmappingにしてください');
  // Aliases are shown as references, never expanded into potentially unbounded data.
  const data = displayValue(doc.contents) as Record<string, Value>;
  const bodyStart = end.index + end[0].length + (text[end.index + end[0].length] === '\n' ? 1 : 0);
  return { doc, data, start, end: end.index, yaml, bodyStart, body: text.slice(bodyStart), eol: text.includes('\r\n') ? '\r\n' : '\n', shared: !doc.has('on') };
}
export type Parsed = ReturnType<typeof parseWorkflow>;
function plainNode(node: unknown, includeComments = false): boolean {
  let safe = true;
  visit(node as Node, (_key, n) => {
    if (isAlias(n) || (n && typeof n === 'object' && 'anchor' in n && n.anchor) || (n && typeof n === 'object' && 'tag' in n && n.tag) ||
      (isScalar(n) && (n.value === '<<' || (typeof n.value === 'string' && n.value.includes('${{')))) ||
      (includeComments && n && typeof n === 'object' && ('comment' in n && n.comment || 'commentBefore' in n && n.commentBefore))) safe = false;
  });
  return safe;
}
function encode(value: Value): string {
  // JSON flow values are valid YAML 1.2 and do not reinterpret strings as booleans or numbers.
  return JSON.stringify(value);
}
export function readField(parsed: Parsed, f: Field): unknown {
  if (f.path[0] === 'engine' && typeof parsed.data.engine === 'string') return f.path[1] === 'id' ? parsed.data.engine : undefined;
  if (f.path[0] === 'on' && parsed.data.on === 'workflow_dispatch') return f.kind === 'presence' ? f.path[1] === 'workflow_dispatch' : undefined;
  const node = parsed.doc.getIn(f.path, true);
  if (f.kind === 'presence') return node !== undefined && !(isScalar(node) && node.value === false);
  if (f.kind === 'boolean' && isMap(node) && f.path[0] === 'tools') return true;
  if (f.path.join('.') === 'tools.github' && isScalar(node) && typeof node.value === 'string') return true;
  if (f.kind === 'boolean' && isScalar(node) && node.value === null) return true;
  const value = parsed.doc.getIn(f.path);
  if (f.kind === 'schedule' && isSeq(node)) return node.items.map(item => isMap(item) && item.items.length === 1 ? item.get('cron') : null);
  return isSeq(node) || isMap(node) ? displayValue(node) : value;
}
export function patchField(text: string, f: Field, value: Value, remove = false, parsed?: Parsed): Patch {
  const p = parsed ?? parseWorkflow(text);
  let path = f.path;
  const root = p.doc.contents as YAMLMap;
  let map = root;
  // A scalar engine/manual trigger can be expanded without changing its meaning.
  const top = root.get(path[0], true);
  if (path.length > 1 && isScalar(top) && typeof top.value === 'string') {
    if (!plainNode(top) || !top.range) throw new SourceEditRequired('Edit this scalar in source / このscalarはソースで編集してください');
    let replacement: Record<string, Value>;
    if (path[0] === 'engine') replacement = { id: top.value };
    else if (path[0] === 'on' && top.value === 'workflow_dispatch') replacement = { workflow_dispatch: null };
    else throw new SourceEditRequired('Unsupported scalar / 未対応のscalarです');
    let branch = replacement;
    for (const key of path.slice(1, -1)) branch = branch[key] = {};
    if (remove) delete branch[path.at(-1)!]; else branch[path.at(-1)!] = formValue(f, value);
    return { start: p.start + top.range[0], end: p.start + top.range[1], text: encode(replacement) };
  }
  for (let i = 0; i < path.length; i++) {
    if (map.flow || map.anchor || map.tag || map.items.some(pair => isScalar(pair.key) && pair.key.value === '<<')) {
      // Existing values inside a plain flow mapping still have precise ranges.
      if (!map.flow || map.anchor || map.tag || map.items.some(pair => isScalar(pair.key) && pair.key.value === '<<')) throw new SourceEditRequired('Edit advanced YAML in source / 高度なYAMLはソースで編集してください');
    }
    const key = path[i];
    const pair = map.items.find(item => isScalar(item.key) && item.key.value === key);
    const node = pair?.value as Node | null | undefined;
    const last = i === path.length - 1;
    if (!last && isMap(node)) { map = node; continue; }
    if (!last && remove && (!node || isScalar(node) && node.value === null)) return { start: 0, end: 0, text: '' };
    const githubEnabled = path[0] === 'tools' && key === 'github' && isScalar(node) && node.value === true;
    if (!last && node && !(isScalar(node) && node.value === null) && !githubEnabled) throw new SourceEditRequired('Edit this structure in source / この構造はソースで編集してください');
    if (remove && !pair) return { start: 0, end: 0, text: '' };
    if (last && pair && remove) {
      if (!plainNode(node, true) || isMap(node) && !knownSubtree(node, path)) throw new SourceEditRequired('Remove this section in source / このセクションの削除はソースで行ってください');
      const keyNode = pair.key as Node;
      if (map.flow) {
        if (!plainNode(map, true)) throw new SourceEditRequired('Edit commented flow mapping in source / コメント付きのflow mappingはソースで編集してください');
        const index = map.items.indexOf(pair);
        let start = keyNode.range![0], end = node?.range?.[1] ?? keyNode.range![1];
        if (index < map.items.length - 1) end = (map.items[index + 1].key as Node).range![0];
        else if (index > 0) start = p.yaml.indexOf(',', (map.items[index - 1].value as Node).range![1]);
        return { start: p.start + start, end: p.start + end, text: '' };
      }
      const start = p.yaml.lastIndexOf('\n', keyNode.range![0] - 1) + 1;
      const valueEnd = node?.range?.[1] ?? keyNode.range![1];
      const lineEnd = p.yaml.indexOf('\n', valueEnd);
      const end = p.yaml[valueEnd - 1] === '\n' ? valueEnd : lineEnd < 0 ? p.yaml.length : lineEnd + 1;
      if (p.yaml.slice(keyNode.range![1], end).includes('#')) throw new SourceEditRequired('Preserve comments in source / コメントを含む項目はソースで削除してください');
      // Keep an empty parent mapping valid instead of turning it into null.
      const emptyParent = map !== root && map.items.length === 1;
      return { start: p.start + start, end: p.start + end, text: emptyParent ? ' '.repeat(keyNode.range![0] - start) + '{}' + p.eol : '' };
    }
    let next: Value = formValue(f, value);
    for (let j = path.length - 1; j > i; j--) next = { [path[j]]: next };
    if (pair) {
      if (last && f.kind === 'presence' && value === true && !(isScalar(node) && node.value === false)) return { start: 0, end: 0, text: '' };
      const githubToggle = last && path.join('.') === 'tools.github';
      if (githubToggle && value === true && (isMap(node) || isScalar(node) && (node.value === null || typeof node.value === 'string'))) return { start: 0, end: 0, text: '' };
      if (!plainNode(node, !isScalar(node)) || (isMap(node) && node.items.length > 0 && !(githubToggle && knownSubtree(node, path))) || (isSeq(node) && f.kind !== 'list' && f.kind !== 'schedule')) throw new SourceEditRequired('Preserve advanced settings in source / 高度な設定はソースで編集してください');
      if (isSeq(node) && f.kind === 'schedule' && !node.items.every(item => isMap(item) && item.items.length === 1 && item.has('cron'))) throw new SourceEditRequired('Schedule has extra settings / scheduleに追加設定があります');
      if (isSeq(node) && f.kind === 'list' && !node.items.every(item => isScalar(item) && typeof item.value === 'string')) throw new SourceEditRequired('Not a string list / 文字列の一覧ではありません');
      if (!node?.range) throw new SourceEditRequired('No safe source range / 安全な編集範囲を特定できません');
      // Keep quote style when changing an ordinary quoted scalar.
      let replacement = encode(next);
      if (isScalar(node) && typeof next === 'string' && node.type === 'QUOTE_SINGLE' && !/[\r\n]/.test(next)) replacement = `'${next.replace(/'/g, "''")}'`;
      const raw = p.yaml.slice(node.range[0], node.range[1]);
      if (isScalar(node) && (node.type === 'BLOCK_LITERAL' || node.type === 'BLOCK_FOLDED')) throw new SourceEditRequired('Edit multiline scalar in source / 複数行文字列はソースで編集してください');
      if (raw.endsWith('\n')) replacement += p.eol;
      if (p.yaml[node.range[0] - 1] === ':') replacement = ' ' + replacement;
      return { start: p.start + node.range[0], end: p.start + node.range[1], text: replacement };
    }
    if (remove) return { start: 0, end: 0, text: '' };
    if (!map.range) throw new SourceEditRequired('Add this field in source / この項目はソースで追加してください');
    if (map.flow) {
      const at = map.range[1] - 1;
      return { start: p.start + at, end: p.start + at, text: `${map.items.length ? ', ' : ''}${encode(key)}: ${encode(next)}` };
    }
    const first = map.items[0]?.key as Node | undefined;
    const indent = first?.range ? first.range[0] - (p.yaml.lastIndexOf('\n', first.range[0] - 1) + 1) : 0;
    const at = map.range[1];
    const prefix = at > 0 && p.yaml[at - 1] !== '\n' ? p.eol : '';
    const added = stringify({ [key]: next }, { indent: 2, lineWidth: 0 }).trimEnd().split('\n').map(line => ' '.repeat(indent) + line).join(p.eol);
    return { start: p.start + at, end: p.start + at, text: prefix + added + p.eol };
  }
  throw new SourceEditRequired('Unsupported edit');
}
function formValue(f: Field, value: Value): Value {
  if (f.kind === 'presence') return null;
  if (f.kind === 'schedule') return (value as string[]).map(cron => ({ cron }));
  return value;
}
export function sourceOffset(p: Parsed, group: string): number {
  if (group === 'instructions') return p.bodyStart;
  const key = group === 'metadata' ? 'name' : group;
  const node = p.doc.get(key, true) as Node | undefined;
  return p.start + (node?.range?.[0] ?? 0);
}
export function fieldModels(p: Parsed, text: string) {
  return fields.map(f => {
    const value = readField(p, f);
    let reason = '';
    try { patchField(text, f, sampleValue(f, value), false, p); } catch (error) { reason = String((error as Error).message); }
    return { ...f, value, reason };
  });
}
export function advancedSettings(p: Parsed) {
  const result: { path: string[]; group: Group; offset: number }[] = [];
  const walk = (map: YAMLMap, parent: string[]) => {
    for (const pair of map.items) {
      const key = String(displayValue(pair.key)), path = [...parent, key];
      if (parent.length === 0 && ['jobs', 'steps', 'post-steps', 'imports'].includes(key)) continue;
      const same = fields.find(f => JSON.stringify(f.path) === JSON.stringify(path));
      const children = fields.some(f => f.path.length > path.length && path.every((key, i) => f.path[i] === key));
      if (children && isMap(pair.value)) walk(pair.value, path);
      else if (!same && !children) result.push({ path, group: fields.find(f => f.path[0] === path[0])?.group ?? 'metadata', offset: p.start + ((pair.key as Node)?.range?.[0] ?? 0) });
    }
  };
  walk(p.doc.contents as YAMLMap, []); return result;
}
function knownSubtree(node: YAMLMap, path: string[]): boolean {
  return node.items.every(pair => {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string') return false;
    const child = [...path, pair.key.value];
    return fields.some(f => f.path.join('.') === child.join('.')) && (!isMap(pair.value) || knownSubtree(pair.value, child));
  });
}
function displayValue(node: unknown): Value {
  if (isAlias(node)) return `*${node.source}`;
  if (isMap(node)) return Object.fromEntries(node.items.map(pair => [String(displayValue(pair.key)), displayValue(pair.value)]));
  if (isSeq(node)) return node.items.map(displayValue);
  if (isScalar(node)) return node.value === null || ['string', 'number', 'boolean'].includes(typeof node.value) ? node.value as Value : String(node.value);
  return null;
}
function sampleValue(f: Field, value: unknown): Value {
  if (f.kind === 'presence' || f.kind === 'boolean') return true;
  if (f.kind === 'list' || f.kind === 'schedule') return Array.isArray(value) && value.every(x => typeof x === 'string') ? value as string[] : [];
  if (f.kind === 'number') return 1;
  return typeof value === 'string' ? value : f.options?.[0] ?? '';
}

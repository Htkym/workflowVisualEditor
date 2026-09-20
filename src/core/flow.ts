import { isAlias, isMap, isScalar, isSeq, parseDocument, stringify, visit, type Node, type YAMLMap, type YAMLSeq } from 'yaml';
import { parseWorkflow, patchField, SourceEditRequired, type Parsed, type Patch } from './document';
import { fields, builtInJobs, jobStepSections, type StepSection, type Value, type Field, type Group, validValue } from './fields';
export { builtInJobs, jobStepSections, type StepSection } from './fields';

// v0.89.21 compiler_custom_jobs.go and compiler_builtin_job_augmentation.go:
// built-in jobs have compiler-owned dependencies; jobs.<custom>.needs is editable.
export type FlowPath = (string | number)[];
export type FlowOrigin = 'user' | 'generated' | 'unknown';
export interface FlowStep { index: number; name: string; values: Record<string, Value>; editable: boolean; origin?: FlowOrigin; sourcePath?: FlowPath }
export interface FlowJob { id: string; name: string; needs: string[]; implicit: boolean; values: Record<string, Value>; steps: FlowStep[]; preSteps?: FlowStep[]; setupSteps?: FlowStep[]; editable: boolean; origin?: FlowOrigin }
export interface Instruction { index: number; title: string; text: string; start: number; end: number; heading: boolean }
export interface FlowModel { jobs: FlowJob[]; agentNeeds: string[]; before: FlowStep[]; after: FlowStep[]; instructions: Instruction[]; beforeEditable: boolean; afterEditable: boolean }
export interface JobGraph { jobs: FlowJob[]; warning?: string }
export interface OverviewJob { id: string; needs: string[]; origin: FlowOrigin; implicit: boolean }
export function sourceOverview(model: FlowModel, data: Record<string, Value>): OverviewJob[] {
  const declared = new Map(model.jobs.map(job => [job.id.replace('-', '_'), job]));
  const custom = model.jobs.filter(job => !builtInJobs.includes(job.id)).map(job => ({ id: job.id, needs: job.needs, origin: 'user' as const, implicit: job.implicit }));
  const trigger = record(data.on);
  const outputs = record(data['safe-outputs']);
  const pre = !!(trigger.issues || trigger.pull_request || declared.has('pre_activation'));
  const detection = Object.values(outputs).some(value => value !== false && value !== null) || declared.has('detection');
  const extra = (id: string) => declared.get(id)?.needs ?? [];
  const standard = (id: string, needs: string[]): OverviewJob => ({ id, needs: [...new Set([...needs, ...extra(id)])], origin: 'generated', implicit: true });
  const nodes: OverviewJob[] = [...custom];
  if (pre) nodes.push(standard('pre_activation', []));
  nodes.push(standard('activation', pre ? ['pre_activation'] : []));
  nodes.push(standard('agent', ['activation', ...model.agentNeeds]));
  if (detection) nodes.push(standard('detection', ['activation', 'agent']));
  nodes.push(standard('safe_outputs', ['activation', 'agent', ...(detection ? ['detection'] : [])]));
  nodes.push(standard('conclusion', nodes.map(job => job.id)));
  return nodes;
}
export interface FlowEdit { action: 'builtin.edit' | 'builtin.clear' | 'agent.needs' | 'job.add' | 'job.edit' | 'job.remove' | 'step.add' | 'step.edit' | 'step.move' | 'step.remove' | 'with.edit' | 'with.remove' | 'instruction.add' | 'instruction.edit' | 'instruction.move' | 'instruction.remove'; job?: string; lane?: 'before' | 'after' | 'job'; section?: StepSection; index?: number; direction?: -1 | 1; field?: string; value?: Value; title?: string; text?: string; kind?: 'run' | 'uses' }
const jobId = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z_][A-Za-z0-9_-]{0,79}$/.test(s);
const short = (s: unknown): s is string => typeof s === 'string' && s.length <= 16_384 && !s.includes('\0');
const bodyText = (s: unknown): s is string => typeof s === 'string' && s.length <= 250_000 && !s.includes('\0');
const jobFields = ['name', 'runs-on', 'needs', 'if'];
const stepFields = ['name', 'run', 'uses', 'if', 'shell', 'working-directory'];
export function validFlowEdit(input: unknown): input is FlowEdit {
  if (!input || typeof input !== 'object') return false;
  const e = input as FlowEdit;
  if (typeof e.action !== 'string') return false;
  if (e.action.startsWith('builtin.')) {
    if (!builtInJobs.includes(e.job!)) return false;
    if (e.action === 'builtin.clear') return ['if', 'needs', 'timeout-minutes'].includes(e.field!) || fields.some(f => f.group === 'permissions' && f.path.join('.') === e.field);
    if (e.action !== 'builtin.edit') return false;
    if (e.field === 'if') return short(e.value);
    if (e.field === 'needs') return Array.isArray(e.value) && e.value.length <= 200 && e.value.every(jobId);
    if (e.field === 'timeout-minutes') return ['agent', 'detection'].includes(e.job!) && typeof e.value === 'number' && Number.isSafeInteger(e.value) && e.value > 0 && e.value <= 2147483647;
    const permission = fields.find(f => f.group === 'permissions' && f.path.join('.') === e.field);
    return !!permission && validValue(permission, e.value);
  }
  if (e.action === 'agent.needs') return Array.isArray(e.value) && e.value.length <= 200 && e.value.every(jobId);
  if (e.action === 'with.edit' || e.action === 'with.remove') {
    if (!jobId(e.field)) return false;
    if (e.index === undefined) { if (e.lane !== 'job' || !jobId(e.job) || builtInJobs.includes(e.job) || e.section !== undefined) return false; }
    else if (!Number.isSafeInteger(e.index) || e.index < 0 || !['before', 'after', 'job'].includes(e.lane!) || e.lane === 'job' && (!jobId(e.job) || !jobStepSections(e.job).includes(e.section ?? 'steps')) || e.lane !== 'job' && e.section !== undefined) return false;
    return e.action === 'with.remove' || short(e.value) || typeof e.value === 'number' && Number.isFinite(e.value) || typeof e.value === 'boolean';
  }
  if (e.action.startsWith('instruction.')) {
    if (e.action === 'instruction.add') return short(e.title) && !!e.title.trim() && !/[\r\n]/.test(e.title) && bodyText(e.text);
    if (!Number.isSafeInteger(e.index) || e.index! < 0) return false;
    if (e.action === 'instruction.edit') return bodyText(e.text) && (e.title === undefined || short(e.title) && !!e.title.trim() && !/[\r\n]/.test(e.title));
    return e.action === 'instruction.remove' || e.action === 'instruction.move' && (e.direction === -1 || e.direction === 1);
  }
  if (e.action.startsWith('job.')) {
    if (!jobId(e.job) || builtInJobs.includes(e.job)) return false;
    if (e.action === 'job.add' || e.action === 'job.remove') return true;
    return e.action === 'job.edit' && jobFields.includes(e.field!) && (e.field === 'needs' ? Array.isArray(e.value) && e.value.length <= 200 && e.value.every(jobId) : short(e.value));
  }
  if (!['before', 'after', 'job'].includes(e.lane!) || e.lane === 'job' && (!jobId(e.job) || !jobStepSections(e.job).includes(e.section ?? 'steps')) || e.lane !== 'job' && e.section !== undefined) return false;
  if (e.action === 'step.add') return e.kind === 'run' || e.kind === 'uses';
  if (!Number.isSafeInteger(e.index) || e.index! < 0) return false;
  if (e.action === 'step.remove') return true;
  if (e.action === 'step.move') return e.direction === -1 || e.direction === 1;
  return e.action === 'step.edit' && stepFields.includes(e.field!) && short(e.value);
}
export function instructionSections(text: string, parsed = parseWorkflow(text)): Instruction[] {
  const starts: { start: number; title: string; content: number }[] = [];
  let offset = parsed.bodyStart, fence = '', htmlComment = false;
  for (const line of parsed.body.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const bare = line.replace(/\r?\n$/, '');
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(bare);
    if (marker && !htmlComment) {
      if (!fence) fence = marker[1]; else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(bare)) fence = '';
    } else if (!fence && !htmlComment) {
      const heading = /^##[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(bare);
      if (heading) starts.push({ start: offset, title: heading[1], content: offset + line.length });
    }
    if (!fence) { if (bare.includes('<!--')) htmlComment = true; if (bare.includes('-->')) htmlComment = false; }
    offset += line.length;
  }
  const sections: Instruction[] = [];
  const first = starts[0]?.start ?? text.length;
  if (first > parsed.bodyStart || !starts.length) sections.push({ index: 0, title: '', text: text.slice(parsed.bodyStart, first), start: parsed.bodyStart, end: first, heading: false });
  starts.forEach((item, i) => sections.push({ index: sections.length, title: item.title, text: text.slice(item.content, starts[i + 1]?.start ?? text.length), start: item.start, end: starts[i + 1]?.start ?? text.length, heading: true }));
  return sections;
}
function record(value: unknown): Record<string, Value> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, Value> : {}; }
function dependencies(value: unknown): string[] {
  return typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}
function steps(node: unknown): FlowStep[] {
  if (!isSeq(node)) return [];
  return node.items.map((item, index) => {
    const values = isMap(item) ? Object.fromEntries(item.items.map(pair => [String((pair.key as { value?: unknown })?.value), plainValue(pair.value)])) : {};
    return { index, values, name: String(values.name ?? values.id ?? values.uses ?? `Step ${index + 1}`), editable: isMap(item) && !item.anchor && !item.tag && !item.has('<<') };
  });
}
function plainValue(node: unknown): Value {
  if (isAlias(node)) return `*${node.source}`;
  if (isScalar(node)) return node.value as Value;
  if (isSeq(node)) return node.items.map(plainValue);
  if (isMap(node)) return Object.fromEntries(node.items.map(p => [String(plainValue(p.key)), plainValue(p.value)]));
  return null;
}
function jobsFrom(node: unknown, source: boolean): FlowJob[] {
  if (!isMap(node)) return [];
  return node.items.map(pair => {
    const id = String(plainValue(pair.key)), values = record(plainValue(pair.value));
    return { id, name: String(values.name ?? id), needs: dependencies(values.needs), implicit: !Object.hasOwn(values, 'needs'), values, steps: steps(isMap(pair.value) ? pair.value.get('steps', true) : undefined), preSteps: steps(isMap(pair.value) ? pair.value.get('pre-steps', true) : undefined), setupSteps: steps(isMap(pair.value) ? pair.value.get('setup-steps', true) : undefined), origin: source ? builtInJobs.includes(id) ? 'generated' as const : 'user' as const : undefined, editable: source && jobId(id) && !builtInJobs.includes(id) && isMap(pair.value) && !pair.value.anchor && !pair.value.tag && !pair.value.has('<<') };
  });
}
export function flowModel(text: string, p = parseWorkflow(text)): FlowModel {
  const before = p.doc.get('steps', true), after = p.doc.get('post-steps', true);
  return { jobs: jobsFrom(p.doc.get('jobs', true), true), agentNeeds: dependencies(record(p.data.on).needs), before: steps(before), after: steps(after), instructions: instructionSections(text, p), beforeEditable: before === undefined || isSeq(before), afterEditable: after === undefined || isSeq(after) };
}
export type SourceSelection = { type: 'jobs' } | { type: 'builtin' | 'job'; id: string } | { type: 'instruction'; index: number } | { type: 'step'; lane: 'before' | 'after' | 'job'; job?: string; index: number; section?: StepSection };
export function sourceContext(text: string, offset: number, p = parseWorkflow(text)): { group: Group; selection?: SourceSelection } {
  const model = flowModel(text, p);
  const contains = (path: FlowPath) => {
    const parent = p.doc.getIn(path.slice(0, -1), true);
    const pair = isMap(parent) ? parent.items.find(pair => isScalar(pair.key) && pair.key.value === path.at(-1)) : undefined;
    const node = p.doc.getIn(path, true) as Node | undefined;
    const range = node?.range, start = (pair?.key as Node)?.range?.[0] ?? range?.[0];
    return start !== undefined && offset >= p.start + start && offset < p.start + (range?.[2] ?? (pair?.key as Node)?.range?.[2] ?? start + 1);
  };
  if (offset >= p.bodyStart) { const section = model.instructions.find(s => offset >= s.start && offset <= s.end); return { group: 'instructions', selection: section && { type: 'instruction', index: section.index } }; }
  if (contains(['jobs'])) {
    for (const job of model.jobs) if (contains(['jobs', job.id])) {
      for (const section of jobStepSections(job.id)) {
        const list = section === 'steps' ? job.steps : section === 'pre-steps' ? job.preSteps! : job.setupSteps!;
        for (const step of list) if (contains(['jobs', job.id, section, step.index])) return { group: 'metadata', selection: { type: 'step', lane: 'job', job: job.id, section, index: step.index } };
      }
      return { group: 'metadata', selection: { type: builtInJobs.includes(job.id) ? 'builtin' : 'job', id: job.id } };
    }
    return { group: 'metadata', selection: { type: 'jobs' } };
  }
  for (const [lane, key, list] of [['before', 'steps', model.before], ['after', 'post-steps', model.after]] as const) if (contains([key])) {
    const step = list.find(step => contains([key, step.index]));
    return { group: 'engine', selection: step ? { type: 'step', lane, index: step.index } : { type: 'jobs' } };
  }
  return { group: fields.find(field => contains([field.path[0]]))?.group ?? (contains(['imports']) ? 'imports' : 'metadata') };
}
export function generatedGraph(yaml: string, source?: Parsed): JobGraph {
  if (yaml.length > 8_000_000) throw new Error('Generated workflow exceeds 8 MB / 生成Workflowが8 MBを超えています');
  const doc = parseDocument(yaml, { uniqueKeys: true });
  if (doc.errors.length || !isMap(doc.contents) || !isMap(doc.get('jobs', true))) throw new Error('Invalid generated jobs / 生成物のjobsを解析できません');
  const jobs = jobsFrom(doc.get('jobs', true), false);
  if (jobs.length > 200) throw new Error('Job graph exceeds 200 jobs / ジョブが200件を超えています');
  for (const job of jobs) {
    const builtin = builtInJobs.includes(job.id);
    job.origin = builtin ? 'generated' : source?.doc.hasIn(['jobs', job.id]) ? 'user' : 'unknown';
    const paths: FlowPath[] = [];
    if (source) {
      const id = job.id === 'pre_activation' && source.doc.hasIn(['jobs', 'pre-activation']) ? 'pre-activation' : job.id;
      for (const section of ['setup-steps', 'pre-steps', 'steps']) paths.push(['jobs', id, section]);
      if (job.id === 'agent') paths.push(['steps'], ['post-steps']);
    }
    const declared = paths.flatMap(path => steps(source!.doc.getIn(path, true)).map(step => ({ ...step, path: [...path, step.index] })));
    const matches = job.steps.map(step => declared.filter(candidate =>
      (typeof candidate.values.run === 'string' || typeof candidate.values.uses === 'string') &&
      Object.entries(candidate.values).every(([key, value]) => sameStepValue(value, step.values[key], key))));
    const matched = new Set<FlowStep>();
    job.steps.forEach((step, index) => {
      const candidates = matches[index];
      const unique = candidates.length === 1 && matches.filter(other => other.includes(candidates[0])).length === 1;
      step.editable = false; step.origin = 'unknown';
      if (unique) { step.origin = 'user'; step.sourcePath = candidates[0].path; matched.add(candidates[0]); }
    });
    // Custom job execution adds scaffolding around these three source sections.
    // Imports, transformed/unmatched steps and built-in augmentation stay conservative.
    if (job.origin === 'user' && !source!.doc.has('imports') && declared.length > 0 && matched.size === declared.length) {
      for (const step of job.steps) if (step.origin !== 'user') step.origin = 'generated';
    }
  }
  const ids = new Set(jobs.map(j => j.id));
  const unknown = jobs.flatMap(j => j.needs.filter(n => !ids.has(n)));
  return { jobs, warning: unknown.length ? `Unresolved dependencies / 未解決の依存: ${[...new Set(unknown)].join(', ')}` : undefined };
}
function sameStepValue(a: unknown, b: unknown, key = ''): boolean {
  if (key === 'run' && typeof a === 'string' && typeof b === 'string') return a.replaceAll('\r\n', '\n').trimEnd() === b.replaceAll('\r\n', '\n').trimEnd();
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((value, i) => sameStepValue(value, b[i]));
  if (a && typeof a === 'object') return !!b && typeof b === 'object' && Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) => Object.hasOwn(b, key) && sameStepValue(value, (b as Record<string, unknown>)[key]));
  return a === b;
}
export function graphLayers(jobs: Pick<FlowJob, 'id' | 'needs'>[]): { layers: string[][]; cyclic: string[] } {
  const remaining = new Map(jobs.map(j => [j.id, j.needs])), done = new Set<string>(), ids = new Set(remaining.keys()), layers: string[][] = [];
  while (remaining.size) {
    const ready = [...remaining].filter(([, needs]) => needs.every(id => done.has(id) || !ids.has(id))).map(([id]) => id);
    if (!ready.length) break;
    layers.push(ready); ready.forEach(id => { remaining.delete(id); done.add(id); });
  }
  return { layers, cyclic: [...remaining.keys()] };
}
const dynamicField = (path: string[], kind: Field['kind'] = 'string'): Field => ({ path, kind, group: 'metadata', label: ['', ''] });
const lineStart = (text: string, at: number) => text.lastIndexOf('\n', at - 1) + 1;
function safeNode(node: unknown, comments = false) {
  let safe = true;
  visit(node as Node, (_key, n) => {
    if (isAlias(n) || n && typeof n === 'object' && ('anchor' in n && n.anchor || 'tag' in n && n.tag || comments && ('comment' in n && n.comment || 'commentBefore' in n && n.commentBefore))) safe = false;
    if (isMap(n) && n.has('<<')) safe = false;
  });
  if (!safe) throw new SourceEditRequired('Edit anchored, merged or commented structures in source / anchor・merge・コメント付き構造はソースで編集してください');
}
function ancestors(p: Parsed, path: FlowPath) {
  for (let i = 0; i < path.length; i++) {
    const node = p.doc.getIn(path.slice(0, i), true);
    if (isAlias(node) || node && typeof node === 'object' && ('anchor' in node && node.anchor || 'tag' in node && node.tag) || isMap(node) && node.has('<<')) throw new SourceEditRequired('Edit this advanced structure in source / この構造はソースで編集してください');
  }
}
function replaceNode(p: Parsed, node: Node, value: Value): Patch {
  safeNode(node);
  if (!node.range) throw new SourceEditRequired('No source range');
  if (isScalar(node) && ['BLOCK_LITERAL', 'BLOCK_FOLDED'].includes(node.type ?? '') && node.comment) throw new SourceEditRequired('Preserve the block comment in source / ブロックのコメントはソースで保全してください');
  const raw = p.yaml.slice(node.range[0], node.range[1]);
  const before = p.yaml[node.range[0] - 1] === ':' ? ' ' : '';
  return { start: p.start + node.range[0], end: p.start + node.range[1], text: before + JSON.stringify(value) + (raw.endsWith('\n') ? p.eol : '') };
}
function setProperty(p: Parsed, path: FlowPath, key: string, value: Value): Patch {
  ancestors(p, [...path, key]);
  const map = p.doc.getIn(path, true);
  if (!isMap(map)) throw new SourceEditRequired('Edit this structure in source / この構造はソースで編集してください');
  const node = map.get(key, true) as Node | undefined;
  if (node) return replaceNode(p, node, value);
  if (!map.range) throw new SourceEditRequired('No source range');
  if (map.flow) { const at = p.start + map.range[1] - 1; return { start: at, end: at, text: `${map.items.length ? ', ' : ''}${JSON.stringify(key)}: ${JSON.stringify(value)}` }; }
  const first = map.items[0]?.key as Node;
  const indent = first.range![0] - lineStart(p.yaml, first.range![0]);
  const at = p.start + map.range[1];
  return { start: at, end: at, text: ' '.repeat(indent) + key + ': ' + JSON.stringify(value) + p.eol };
}
function removeProperty(p: Parsed, path: FlowPath, key: string): Patch {
  ancestors(p, [...path, key]);
  const map = p.doc.getIn(path, true);
  if (!isMap(map)) throw new SourceEditRequired('Edit this structure in source / この構造はソースで編集してください');
  const index = map.items.findIndex(pair => isScalar(pair.key) && pair.key.value === key);
  const pair = map.items[index];
  if (!pair) throw new Error('Unknown input / 入力項目が見つかりません');
  safeNode(pair.key, true); safeNode(pair.value, true);
  const node = pair.value as Node, keyNode = pair.key as Node;
  if (!node.range || !keyNode.range) throw new SourceEditRequired('No source range / ソース位置を特定できません');
  if (map.flow) {
    safeNode(map, true);
    if (map.items.length === 1) return replaceNode(p, map, {});
    const start = index ? p.yaml.indexOf(',', (map.items[index - 1].value as Node).range![1]) : keyNode.range[0];
    const end = index ? node.range[1] : (map.items[1].key as Node).range![0];
    return { start: p.start + start, end: p.start + end, text: '' };
  }
  const start = lineStart(p.yaml, keyNode.range[0]);
  const end = node.range[2] > node.range[1] ? node.range[2] : (p.yaml.indexOf('\n', node.range[1]) + 1 || p.yaml.length);
  return { start: p.start + start, end: p.start + end, text: '' };
}
function addWith(p: Parsed, path: FlowPath, key: string, value: Value): Patch {
  const parent = p.doc.getIn(path, true);
  if (!isMap(parent) || !parent.range) throw new SourceEditRequired('Edit this structure in source / この構造はソースで編集してください');
  if (parent.flow) return setProperty(p, path, 'with', { [key]: value });
  const first = parent.items[0]?.key as Node | undefined;
  const indent = first?.range ? first.range[0] - lineStart(p.yaml, first.range[0]) : 0;
  const at = parent.range[1];
  const prefix = at > 0 && p.yaml[at - 1] !== '\n' ? p.eol : '';
  return { start: p.start + at, end: p.start + at, text: prefix + ' '.repeat(indent) + 'with:' + p.eol + ' '.repeat(indent + 2) + key + ': ' + JSON.stringify(value) + p.eol };
}
function stepPath(e: FlowEdit): string[] { return e.lane === 'job' ? ['jobs', e.job!, e.section ?? 'steps'] : [e.lane === 'before' ? 'steps' : 'post-steps']; }
function sequenceSpans(p: Parsed, seq: YAMLSeq): { start: number; end: number }[] {
  safeNode(seq, true);
  if (seq.flow) return seq.items.map(item => { const node = item as Node; if (!node?.range) throw new SourceEditRequired('No step range'); return { start: node.range[0], end: node.range[1] }; });
  if (seq.srcToken?.type !== 'block-seq') throw new SourceEditRequired('Edit this sequence in source');
  const starts = seq.srcToken.items.map(item => {
    const marker = item.start.find(token => token.type === 'seq-item-ind');
    if (!marker) throw new SourceEditRequired('No step boundary');
    return lineStart(p.yaml, marker.offset);
  });
  return starts.map((start, i) => ({ start, end: starts[i + 1] ?? seq.range![1] }));
}
export function planFlowEdit(text: string, edit: FlowEdit): Patch {
  if (!validFlowEdit(edit)) throw new Error('Invalid flow edit / フローの編集要求が不正です');
  const p = parseWorkflow(text), e = edit;
  let patch: Patch;
  if (e.action.startsWith('instruction.')) patch = patchInstruction(text, p, e);
  else if (e.action === 'builtin.edit' || e.action === 'builtin.clear') patch = patchField(text, dynamicField(['jobs', e.job!, ...e.field!.split('.')]), e.value ?? null, e.action === 'builtin.clear');
  else if (e.action === 'agent.needs') patch = patchField(text, dynamicField(['on', 'needs'], 'list'), e.value!);
  else if (e.action === 'with.edit' || e.action === 'with.remove') {
    const path: FlowPath = e.index === undefined ? ['jobs', e.job!] : [...stepPath(e), e.index];
    ancestors(p, path);
    const parent = p.doc.getIn(path, true);
    if (!isMap(parent) || typeof parent.get('uses') !== 'string' || parent.has('run')) throw new SourceEditRequired('with is available on uses actions / withはusesを指定したActionで編集できます');
    const withNode = parent.get('with', true);
    if (withNode === undefined) {
      if (e.action === 'with.remove') throw new Error('Unknown input / 入力項目が見つかりません');
      patch = addWith(p, path, e.field!, e.value!);
    } else if (!isMap(withNode)) throw new SourceEditRequired('Edit this with mapping in source / このwith設定はソースで編集してください');
    else if (e.action === 'with.edit') patch = setProperty(p, [...path, 'with'], e.field!, e.value!);
    else patch = withNode.items.length === 1 ? removeProperty(p, path, 'with') : removeProperty(p, [...path, 'with'], e.field!);
  }
  else if (e.action === 'job.add') {
    if (p.doc.hasIn(['jobs', e.job!])) throw new Error('Job already exists / 同名のジョブが存在します');
    patch = patchField(text, dynamicField(['jobs', e.job!]), { name: e.job!, 'runs-on': 'ubuntu-latest', needs: ['agent'], steps: [{ name: 'New step', run: 'echo "Ready"' }] });
  } else if (e.action === 'job.edit') {
    if (!p.doc.hasIn(['jobs', e.job!])) throw new Error('Unknown job');
    patch = setProperty(p, ['jobs', e.job!], e.field!, e.value!);
  } else if (e.action === 'job.remove') {
    const model = flowModel(text, p);
    if (model.jobs.some(j => j.id !== e.job && j.needs.includes(e.job!)) || dependencies(record(p.data.on).needs).includes(e.job!)) throw new Error('Remove dependent edges first / 先にこのジョブへの依存を解除してください');
    patch = removeJob(p, e.job!);
  } else {
    const path = stepPath(e); ancestors(p, [...path, 0]);
    if (e.lane === 'job' && !builtInJobs.includes(e.job!) && !p.doc.hasIn(['jobs', e.job!])) throw new Error('Unknown job');
    const seq = p.doc.getIn(path, true);
    if (e.action === 'step.add') {
      const existing = e.lane === 'job' ? steps(seq) : [...steps(p.doc.get('steps', true)), ...steps(p.doc.get('post-steps', true))];
      const names = new Set(existing.map(s => s.name));
      const prefix = e.lane === 'before' ? 'Before agent' : e.lane === 'after' ? 'After agent' : 'Step';
      let number = 1;
      while (names.has(`${prefix} ${number}`)) number++;
      const name = `${prefix} ${number}`;
      const value: Value = e.kind === 'uses' ? { name, uses: 'actions/checkout@v4' } : { name, run: 'echo "Ready"' };
      if (seq === undefined) patch = patchField(text, dynamicField(path), [value]);
      else if (!isSeq(seq)) throw new SourceEditRequired('Edit non-array steps in source / 配列以外のstepsはソースで編集してください');
      else if (seq.flow) { const at = p.start + seq.range![1] - 1; patch = { start: at, end: at, text: `${seq.items.length ? ', ' : ''}${JSON.stringify(value)}` }; }
      else {
        if (seq.srcToken?.type !== 'block-seq') throw new SourceEditRequired('No sequence range');
        const at = p.start + seq.range![1], indent = seq.srcToken.indent;
        const added = stringify([value], { lineWidth: 0 }).trimEnd().split('\n').map(s => ' '.repeat(indent) + s).join(p.eol) + p.eol;
        patch = { start: at, end: at, text: added };
      }
    } else {
      if (!isSeq(seq) || !seq.items[e.index!]) throw new Error('Unknown step / ステップが見つかりません');
      if (e.action === 'step.edit') {
        const node = seq.items[e.index!];
        if (isMap(node) && (e.field === 'run' && node.has('uses') || e.field === 'uses' && node.has('run'))) throw new Error('Keep run and uses as separate step types / runとusesは別のステップとして指定してください');
        patch = setProperty(p, [...path, e.index!], e.field!, e.value!);
      } else {
        const spans = sequenceSpans(p, seq), current = spans[e.index!];
        if (e.action === 'step.move') {
          const other = spans[e.index! + e.direction!]; if (!other) throw new Error('No adjacent step');
          const [a, b] = current.start < other.start ? [current, other] : [other, current];
          patch = { start: p.start + a.start, end: p.start + b.end, text: p.yaml.slice(b.start, b.end) + p.yaml.slice(a.end, b.start) + p.yaml.slice(a.start, a.end) };
        } else if (seq.items.length === 1) patch = replaceNode(p, seq, []);
        else {
          let { start, end } = current;
          if (seq.flow) { if (e.index! < spans.length - 1) end = spans[e.index! + 1].start; else start = p.yaml.indexOf(',', spans[e.index! - 1].end); }
          patch = { start: p.start + start, end: p.start + end, text: '' };
        }
      }
    }
  }
  const updated = text.slice(0, patch.start) + patch.text + text.slice(patch.end);
  const candidate = parseWorkflow(updated);
  if (!e.action.startsWith('instruction.')) {
    if (candidate.body !== p.body) throw new Error('Edit would affect instructions / 本文を変更する編集は拒否しました');
    const flow = flowModel(updated, candidate), jobs = flow.jobs;
    const graph = [...jobs.filter(j => !builtInJobs.includes(j.id)), { id: 'activation', needs: [...flow.agentNeeds, ...(jobs.find(j => j.id === 'activation')?.needs ?? [])] }, { id: 'agent', needs: ['activation', ...(jobs.find(j => j.id === 'agent')?.needs ?? [])] }, ...jobs.filter(j => builtInJobs.includes(j.id) && !['activation', 'agent'].includes(j.id))];
    if (jobs.length > 200 || graphLayers(graph).cyclic.length) throw new Error('Cyclic or oversized job graph / ジョブの循環参照または件数上限を検出しました');
    if (e.action === 'agent.needs' && (e.value as string[]).some(id => builtInJobs.includes(id) || !jobs.some(j => j.id === id))) throw new Error('Choose a declared custom job / 定義済みのカスタムジョブを選んでください');
    if ((e.action === 'job.edit' || e.action === 'builtin.edit') && e.field === 'needs') {
      const known = new Set([...builtInJobs, ...jobs.map(j => j.id)]);
      if ((e.value as string[]).some(id => id === e.job || !known.has(id))) throw new Error('Unknown dependency or self dependency / 不明な依存先または自己参照です');
    }
  }
  if (e.action === 'job.remove') {
    const outside = text.slice(0, patch.start) + text.slice(patch.end);
    if (new RegExp(`\\bneeds(?:\\s*\\.\\s*${e.job}\\b|\\s*\\[\\s*['"]${e.job}['"]\\s*\\])`).test(outside)) throw new Error('Job outputs are still referenced / このジョブの出力が参照されています');
  }
  return patch;
}
function removeJob(p: Parsed, id: string): Patch {
  ancestors(p, ['jobs', id]);
  const map = p.doc.get('jobs', true); if (!isMap(map)) throw new Error('Unknown job');
  const i = map.items.findIndex(pair => plainValue(pair.key) === id), pair = map.items[i]; if (!pair) throw new Error('Unknown job');
  safeNode(pair.value); const key = pair.key as Node, node = pair.value as Node;
  if (map.items.length === 1) return replaceNode(p, map, {});
  if (map.flow) {
    safeNode(map, true);
    const start = i ? p.yaml.indexOf(',', (map.items[i - 1].value as Node).range![1]) : key.range![0];
    const end = i ? node.range![1] : (map.items[i + 1].key as Node).range![0];
    return { start: p.start + start, end: p.start + end, text: '' };
  }
  const start = lineStart(p.yaml, key.range![0]), end = node.range![2];
  return { start: p.start + start, end: p.start + end, text: '' };
}
function patchInstruction(text: string, p: Parsed, e: FlowEdit): Patch {
  const normalized = (s: string) => s.replace(/\r\n|\r|\n/g, p.eol);
  const heading = (title: string, content: string) => `## ${title.trim()}${p.eol}${p.eol}${normalized(content).replace(/\s*$/, '')}${p.eol}${p.eol}`;
  if (e.action === 'instruction.add') return { start: text.length, end: text.length, text: (text.endsWith(p.eol + p.eol) ? '' : p.eol) + heading(e.title!, e.text!) };
  const sections = instructionSections(text, p), section = sections[e.index!]; if (!section) throw new Error('Unknown instruction section');
  if (e.action === 'instruction.edit') return { start: section.start, end: section.end, text: section.heading ? heading(e.title ?? section.title, e.text!) : normalized(e.text!) + (section.end < text.length && !e.text!.endsWith('\n') ? p.eol : '') };
  if (!section.heading) throw new Error('The introduction stays first / 冒頭の指示は先頭に残します');
  if (e.action === 'instruction.remove') return { start: section.start, end: section.end, text: '' };
  const adjacent = sections[e.index! + e.direction!]; if (!adjacent?.heading) throw new Error('No adjacent instruction step / 隣の手順がありません');
  const [a, b] = section.start < adjacent.start ? [section, adjacent] : [adjacent, section];
  const first = text.slice(b.start, b.end);
  return { start: a.start, end: b.end, text: first + (first.endsWith('\n') ? '' : p.eol) + text.slice(a.start, a.end) };
}

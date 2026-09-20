import { graphLayers, sourceOverview, type FlowModel, type OverviewJob } from '../src/core/flow';
import type { Value } from '../src/core/fields';

const t = (en: string, ja: string) => document.documentElement.lang === 'ja' ? ja : en;
const svgNode = <K extends keyof SVGElementTagNameMap>(name: K) => document.createElementNS('http://www.w3.org/2000/svg', name);

export function drawOverview(parent: HTMLElement, model: FlowModel, data: Record<string, Value>, select: (job: OverviewJob) => void) {
  const jobs = sourceOverview(model, data), byId = new Map(jobs.map(job => [job.id, job]));
  const { layers, cyclic } = graphLayers(jobs);
  if (cyclic.length) layers.push(cyclic);
  const title = document.createElement('h2'); title.textContent = t('Workflow flow from Markdown', 'Markdownから分かる処理の流れ');
  const note = document.createElement('p'); note.className = 'hint'; note.textContent = t('Solid lines are declared needs. Dashed lines and dashed cards are expected gh-aw jobs based on observed compiler behavior; the compiler can add or change dependencies. This is not a live run.', '実線はMarkdownに明示したneedsです。破線と破線のカードは、確認済みのコンパイル動作から予想した標準ジョブです。実際の依存関係はCLIで変わる場合があります。実行状況ではありません。');
  parent.replaceChildren(title, note);
  if (jobs.length > 200) { const limit = document.createElement('p'); limit.textContent = t('The diagram supports up to 200 jobs. Edit this workflow in Markdown.', '図に表示できるジョブは200件までです。Markdownで編集してください。'); parent.append(limit); return; }
  if (cyclic.length) { const warning = document.createElement('p'); warning.className = 'diagnostic'; warning.textContent = t('Unresolved cycle: ', '循環している依存関係: ') + cyclic.join(', '); parent.append(warning); }
  const width = Math.max(560, ...layers.map(layer => layer.length * 240 + 40));
  const height = layers.length * 122 + 35;
  const positions = new Map<string, { x: number; y: number }>();
  layers.forEach((layer, rank) => layer.forEach((id, index) => positions.set(id, { x: (width - layer.length * 240) / 2 + index * 240 + 10, y: rank * 122 + 18 })));
  const svg = svgNode('svg'); svg.setAttribute('viewBox', `0 0 ${width} ${height}`); svg.setAttribute('width', String(width)); svg.setAttribute('height', String(height)); svg.setAttribute('aria-label', t('Job dependency diagram', 'ジョブの依存関係図')); svg.classList.add('overview-svg');
  const defs = svgNode('defs'), marker = svgNode('marker'); marker.id = 'overview-arrow'; marker.setAttribute('viewBox', '0 0 10 10'); marker.setAttribute('refX', '9'); marker.setAttribute('refY', '5'); marker.setAttribute('markerWidth', '6'); marker.setAttribute('markerHeight', '6'); marker.setAttribute('orient', 'auto');
  const arrow = svgNode('path'); arrow.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z'); marker.append(arrow); defs.append(marker); svg.append(defs);
  for (const job of jobs) for (const need of job.needs) {
    const from = positions.get(need), to = positions.get(job.id); if (!from || !to) continue;
    const edge = svgNode('path'); edge.setAttribute('d', `M ${from.x + 105} ${from.y + 76} C ${from.x + 105} ${from.y + 94}, ${to.x + 105} ${to.y - 18}, ${to.x + 105} ${to.y}`); edge.setAttribute('marker-end', 'url(#overview-arrow)'); edge.classList.add('overview-edge');
    edge.dataset.from = need; edge.dataset.to = job.id; if (job.origin === 'generated') edge.dataset.expected = 'true'; svg.append(edge);
  }
  for (const job of jobs) {
    const at = positions.get(job.id)!;
    const node = svgNode('g'); node.setAttribute('transform', `translate(${at.x} ${at.y})`); node.setAttribute('role', 'button'); node.setAttribute('tabindex', '0'); node.setAttribute('aria-label', `${job.id}: ${job.origin === 'user' ? t('declared job', '定義済みジョブ') : t('expected gh-aw job', 'gh-aw標準ジョブの予想')}. ${t('Needs', '依存先')}: ${job.needs.join(', ') || t('none declared', '明示なし')}`); node.dataset.overviewJob = job.id; node.dataset.origin = job.origin;
    const rect = svgNode('rect'); rect.setAttribute('width', '210'); rect.setAttribute('height', '76'); rect.setAttribute('rx', '6');
    const name = svgNode('text'); name.setAttribute('x', '12'); name.setAttribute('y', '28'); name.textContent = job.id.length > 23 ? job.id.slice(0, 22) + '…' : job.id;
    const label = svgNode('text'); label.setAttribute('x', '12'); label.setAttribute('y', '54'); label.textContent = job.origin === 'user' ? job.implicit ? t('needs not declared', 'needs未指定') : t('Declared in Markdown', 'Markdownで定義') : t('Expected gh-aw job', 'gh-aw標準ジョブの予想'); label.classList.add('overview-detail');
    node.onclick = () => select(job); node.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(job); } };
    node.append(rect, name, label); svg.append(node);
  }
  const scroll = document.createElement('div'); scroll.className = 'overview-scroll'; scroll.tabIndex = 0; scroll.append(svg); parent.append(scroll);
  const details = document.createElement('details'), summary = document.createElement('summary'); summary.textContent = t('Dependencies as text', '依存関係を文字で確認'); details.append(summary);
  const list = document.createElement('ul');
  for (const job of jobs) { const item = document.createElement('li'); item.textContent = `${job.id} ← ${job.needs.filter(id => byId.has(id)).join(', ') || '—'}${job.implicit && job.origin === 'user' ? t(' (compiler may add dependencies)', '（CLIが依存先を追加する場合があります）') : ''}`; list.append(item); }
  details.append(list); parent.append(details);
  const missing = [...new Set(jobs.flatMap(job => job.needs.filter(id => !byId.has(id))))];
  if (missing.length) { const warning = document.createElement('p'); warning.className = 'hint'; warning.textContent = t('References outside this Markdown: ', 'このMarkdownの外にある参照: ') + missing.join(', '); parent.append(warning); }
}

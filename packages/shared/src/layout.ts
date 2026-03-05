import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode, ElkExtendedEdge } from 'elkjs/lib/elk-api.js';
import { sortedSteps, type EdgeRoute, type Plan, type PlanNode, type Rect } from './schema.js';

export const DEFAULT_SIZES = {
  component: { w: 200, h: 72 },
  file: { w: 240, h: 56 },
  external: { w: 180, h: 64 },
  step: { w: 300, h: 76 },
  constraint: { w: 220, h: 110 },
  comment: { w: 200, h: 110 },
} as const;

const STEP_GAP = 16;
const COLUMN_GAP = 140;
const STICKY_GAP = 24;

export interface AutoLayoutOptions {
  /** Re-layout everything, discarding existing positions. */
  force?: boolean;
}

function nodeSize(n: PlanNode) {
  return DEFAULT_SIZES[n.kind];
}

function bounds(
  rects: Rect[],
): { minX: number; minY: number; maxX: number; maxY: number } | undefined {
  if (!rects.length) return undefined;
  return {
    minX: Math.min(...rects.map((r) => r.x)),
    minY: Math.min(...rects.map((r) => r.y)),
    maxX: Math.max(...rects.map((r) => r.x + r.w)),
    maxY: Math.max(...rects.map((r) => r.y + r.h)),
  };
}

/** Node ids whose parent chain is valid (exists and is acyclic). */
function validParents(nodes: readonly PlanNode[]): Map<string, string | undefined> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const parent = new Map<string, string | undefined>();
  for (const n of nodes) {
    let p = n.parentId;
    const seen = new Set([n.id]);
    let ok = !!p;
    while (p) {
      if (seen.has(p) || !byId.has(p)) {
        ok = false;
        break;
      }
      seen.add(p);
      p = byId.get(p)?.parentId;
    }
    parent.set(n.id, ok ? n.parentId : undefined);
  }
  return parent;
}

interface GraphLayout {
  rects: Map<string, Rect>;
  /** Edge routes, without the endpoint rects (filled in once the final offset is known). */
  routes: Map<string, EdgeRoute['points']>;
}

/** Rough size of an edge label as the board draws it (12px, weight 500, 6px padding). */
function labelSize(text: string) {
  return { width: Math.ceil(text.length * 7 + 12), height: 20 };
}

async function layoutGraph(nodes: readonly PlanNode[], edges: Plan['edges']): Promise<GraphLayout> {
  const out = new Map<string, Rect>();
  const routes: GraphLayout['routes'] = new Map();
  if (!nodes.length) return { rects: out, routes };
  const parents = validParents(nodes);
  const ids = new Set(nodes.map((n) => n.id));
  const elkNodes = new Map<string, ElkNode>();
  for (const n of nodes) {
    const size = nodeSize(n);
    elkNodes.set(n.id, { id: n.id, width: size.w, height: size.h, children: [] });
  }
  const root: ElkNode = {
    id: '__root__',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.spacing.nodeNode': '60',
      'elk.layered.spacing.nodeNodeBetweenLayers': '50',
      'elk.layered.spacing.edgeNodeBetweenLayers': '30',
      'elk.spacing.edgeEdge': '24',
      'elk.spacing.edgeNode': '30',
      'elk.spacing.edgeLabel': '6',
      'elk.edgeLabels.placement': 'CENTER',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      // Try harder to untangle arrows: fewer crossings read as a cleaner diagram.
      'elk.layered.thoroughness': '30',
      'elk.layered.crossingMinimization.greedySwitch.type': 'TWO_SIDED',
      // Edge (and edge label) coordinates relative to the root, like our layout.
      'elk.json.edgeCoords': 'ROOT',
    },
    children: [],
    edges: [],
  };
  for (const n of nodes) {
    const elkNode = elkNodes.get(n.id)!;
    const p = parents.get(n.id);
    if (p && ids.has(p)) {
      const parent = elkNodes.get(p)!;
      parent.children!.push(elkNode);
      parent.layoutOptions = {
        'elk.padding': '[top=48,left=20,bottom=20,right=20]',
        'elk.direction': 'DOWN',
      };
    } else {
      root.children!.push(elkNode);
    }
  }
  // Parents must not keep their fixed size, ELK grows them around their children.
  for (const node of elkNodes.values()) {
    if (node.children?.length) {
      delete node.width;
      delete node.height;
    }
  }
  root.edges = edges
    .filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to)
    .map((e): ElkExtendedEdge => ({
      id: e.id,
      sources: [e.from],
      targets: [e.to],
      ...(e.label
        ? { labels: [{ id: `${e.id}__label`, text: e.label, ...labelSize(e.label) }] }
        : {}),
    }));

  const elk = new ELK();
  const result = await elk.layout(root);
  const walk = (node: ElkNode, ox: number, oy: number) => {
    for (const child of node.children ?? []) {
      const x = ox + (child.x ?? 0);
      const y = oy + (child.y ?? 0);
      out.set(child.id, {
        x: Math.round(x),
        y: Math.round(y),
        w: Math.round(child.width ?? 0),
        h: Math.round(child.height ?? 0),
      });
      walk(child, x, y);
    }
  };
  walk(result, 0, 0);
  for (const e of result.edges ?? []) {
    const sec = e.sections?.[0];
    if (!sec || (e.sections?.length ?? 0) > 1) continue;
    const points = [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint].map((p) => ({
      x: Math.round(p.x),
      y: Math.round(p.y),
    }));
    routes.set(e.id, points);
  }
  return { rects: out, routes };
}

/**
 * Assigns a layout rect to every node, step, constraint and comment that lacks one
 * (or to all of them with `force`). Graph nodes go through ELK's layered algorithm,
 * left to right. Steps stack in a column to the right, constraints sit in a row above,
 * and comments go next to whatever they are attached to.
 */
export async function autoLayout(plan: Plan, opts: AutoLayoutOptions = {}): Promise<Plan> {
  const layout: Record<string, Rect> = opts.force ? {} : { ...plan.layout };

  // Graph nodes
  const routes: GraphLayout['routes'] = new Map();
  const missingNodes = plan.nodes.filter((n) => !layout[n.id]);
  if (missingNodes.length) {
    const existing = bounds(plan.nodes.filter((n) => layout[n.id]).map((n) => layout[n.id]!));
    // Lay out the new nodes as their own graph. Without `force`, put them below what the user arranged.
    const missingIds = new Set(missingNodes.map((n) => n.id));
    const sub = missingNodes.map((n) =>
      n.parentId && !missingIds.has(n.parentId) ? { ...n, parentId: undefined } : n,
    );
    const { rects, routes: newRoutes } = await layoutGraph(sub, plan.edges);
    const dx = existing ? existing.minX : 0;
    const dy = existing ? existing.maxY + 80 : 0;
    for (const [id, r] of rects) layout[id] = { ...r, x: r.x + dx, y: r.y + dy };
    const shift = (p: { x: number; y: number }) => ({ x: p.x + dx, y: p.y + dy });
    for (const [id, points] of newRoutes) routes.set(id, points.map(shift));
  }

  const graph = bounds(plan.nodes.map((n) => layout[n.id]).filter((r): r is Rect => !!r)) ?? {
    minX: 0,
    minY: 0,
    maxX: 0,
    maxY: 0,
  };

  // Steps: a column right of the graph, in order.
  const steps = sortedSteps(plan.steps);
  const placedSteps = steps.filter((s) => layout[s.id]).map((s) => layout[s.id]!);
  const stepCol = bounds(placedSteps);
  const stepX = stepCol ? stepCol.minX : graph.maxX + COLUMN_GAP;
  let stepY = stepCol ? stepCol.maxY + STEP_GAP : graph.minY;
  for (const s of steps) {
    if (layout[s.id]) continue;
    const { w, h } = DEFAULT_SIZES.step;
    layout[s.id] = { x: stepX, y: stepY, w, h };
    stepY += h + STEP_GAP;
  }

  // Constraints: a row above the graph.
  const placedCons = plan.constraints.filter((c) => layout[c.id]).map((c) => layout[c.id]!);
  const consRow = bounds(placedCons);
  let consX = consRow ? consRow.maxX + STICKY_GAP : graph.minX;
  const consY = consRow ? consRow.minY : graph.minY - DEFAULT_SIZES.constraint.h - 60;
  for (const c of plan.constraints) {
    if (layout[c.id]) continue;
    const { w, h } = DEFAULT_SIZES.constraint;
    layout[c.id] = { x: consX, y: consY, w, h };
    consX += w + STICKY_GAP;
  }

  // Comments: beside the attached element, otherwise in a row below the graph.
  let looseX = graph.minX;
  const looseY = graph.maxY + 60;
  for (const c of plan.comments) {
    if (layout[c.id]) continue;
    const { w, h } = DEFAULT_SIZES.comment;
    const target = c.attachedTo ? layout[c.attachedTo] : undefined;
    if (target) {
      layout[c.id] = { x: target.x + target.w + 20, y: target.y - h / 2, w, h };
    } else {
      layout[c.id] = { x: looseX, y: looseY, w, h };
      looseX += w + STICKY_GAP;
    }
  }

  // Record each new route with the node rects it was computed for. With `force`, stale routes go.
  const edges = plan.edges.map((e) => {
    const points = routes.get(e.id);
    const from = layout[e.from];
    const to = layout[e.to];
    if (points && from && to) return { ...e, route: { points, from, to } };
    if (opts.force && e.route) {
      const { route: _drop, ...rest } = e;
      return rest;
    }
    return e;
  });
  return { ...plan, edges, layout };
}

/**
 * Layout after a sync from code. A board made only of generated boxes is laid out afresh as
 * one graph whenever boxes were added, so its arrows are routed around boxes instead of cutting
 * across the board. A drawing keeps every position; external systems added to it go in a
 * column on its right, where arrows reach them without crossing the drawing.
 */
export async function layoutSynced(plan: Plan, added: readonly string[]): Promise<Plan> {
  if (!added.length) return autoLayout(plan);
  const nodeIds = new Set(plan.nodes.map((n) => n.id));
  if (plan.nodes.every((n) => n.origin === 'code')) {
    const layout = Object.fromEntries(
      Object.entries(plan.layout).filter(([id]) => !nodeIds.has(id)),
    );
    const edges = plan.edges.map(({ route: _route, ...e }) => e);
    return autoLayout({ ...plan, layout, edges });
  }
  const placed = bounds(plan.nodes.filter((n) => plan.layout[n.id]).map((n) => plan.layout[n.id]!));
  const fresh = new Set(added);
  const systems = plan.nodes.filter((n) => fresh.has(n.id) && n.kind === 'external');
  if (!placed || !systems.length) return autoLayout(plan);
  const layout = { ...plan.layout };
  let y = placed.minY;
  for (const s of systems) {
    const { w, h } = DEFAULT_SIZES.external;
    layout[s.id] = { x: placed.maxX + COLUMN_GAP, y, w, h };
    y += h + 40;
  }
  return autoLayout({ ...plan, layout });
}

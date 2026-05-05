import type {
  Comment,
  Constraint,
  Edge,
  FreeformShape,
  Plan,
  PlanNode,
  Step,
} from '@agentic-whiteboard/shared';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Pt {
  x: number;
  y: number;
}

interface ElementBase extends Box {
  id: string;
}

/** A plan node (component, file, external). */
export interface NodeElement extends ElementBase {
  kind: 'node';
  data: PlanNode;
}
export interface StepElement extends ElementBase {
  kind: 'step';
  data: Step;
}
export interface ConstraintElement extends ElementBase {
  kind: 'constraint';
  data: Constraint;
}
export interface CommentElement extends ElementBase {
  kind: 'comment';
  data: Comment;
}
/** A free-form drawing element. Its box mirrors data.x/y/w/h. */
export interface ShapeElement extends ElementBase {
  kind: 'shape';
  data: FreeformShape;
}

export type SceneElement =
  NodeElement | StepElement | ConstraintElement | CommentElement | ShapeElement;
export type ElementKind = SceneElement['kind'];

/** Plan fields the canvas does not draw, carried through untouched. */
// Not Omit<Plan, ...>: Plan has an index signature (unknown keys are preserved), which Omit collapses.
export type PlanMeta = Pick<
  Plan,
  'version' | 'revision' | 'id' | 'title' | 'prompt' | 'status' | 'updatedAt'
> &
  Record<string, unknown>;

/**
 * What the canvas edits. Elements are in z-order (first = bottom). Plan edges are arrows
 * bound to two node elements and have no box of their own.
 */
export interface Scene {
  meta: PlanMeta;
  elements: SceneElement[];
  edges: Edge[];
  /** Freeform entries the canvas does not understand; preserved verbatim. */
  unknownShapes: unknown[];
  /** Ids of elements that had no layout entry and were given a fallback position. */
  unplaced: string[];
}

/**
 * The seam between Agentic Whiteboard and its canvas implementation. Everything outside `canvas/`
 * talks to the plan model; only the adapter knows how plans map to drawable elements.
 * Swapping the canvas library means writing another adapter and canvas component.
 */
export interface CanvasAdapter {
  readonly name: string;
  toScene(plan: Plan): Scene;
  fromScene(scene: Scene): Plan;
  exportSvg(svg: SVGSVGElement, scene: Scene): string;
  exportPng(svg: SVGSVGElement, scene: Scene, scale?: number): Promise<string>;
}

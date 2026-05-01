import rough from 'roughjs';
import type { Drawable, Options } from 'roughjs/bin/core';
import type { RoughGenerator } from 'roughjs/bin/generator';

export interface RoughPath {
  d: string;
  stroke: string;
  strokeWidth: number;
  fill?: string;
}

const generator: RoughGenerator = rough.generator();
const cache = new Map<string, RoughPath[]>();

/**
 * Generates hand-drawn paths once per (shape, size, style, seed) and caches them, so moving a
 * shape never regenerates it and its wobble stays stable.
 */
export function roughPaths(key: string, make: (g: RoughGenerator) => Drawable): RoughPath[] {
  const hit = cache.get(key);
  if (hit) return hit;
  const paths = generator.toPaths(make(generator)).map((p) => ({
    d: p.d,
    stroke: p.stroke,
    strokeWidth: p.strokeWidth,
    fill: p.fill,
  }));
  if (cache.size > 4000) cache.delete(cache.keys().next().value!);
  cache.set(key, paths);
  return paths;
}

export function roughOptions(seed: number, o: Options): Options {
  return {
    seed,
    roughness: 1,
    bowing: 0.8,
    preserveVertices: true,
    fillWeight: 1.2,
    hachureGap: 7,
    ...o,
  };
}

import { validatePlan, type Plan } from './schema.js';

export type ParseResult =
  { ok: true; plan: Plan; warnings: string[] } | { ok: false; errors: string[] };

export function parsePlanText(text: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { ok: false, errors: [`Malformed JSON: ${(err as Error).message}`] };
  }
  return validatePlan(json);
}

export function serializePlan(plan: Plan): string {
  return JSON.stringify(plan, null, 2) + '\n';
}

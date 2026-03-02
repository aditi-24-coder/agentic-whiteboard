export function slugify(text: string, maxLength = 48): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return slug || 'plan';
}

/** Returns `base`, or `base-2`, `base-3`, ..., whichever is not in `taken`. */
export function uniqueId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Short random id for elements created on the canvas. */
export function randomId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Branches (offices) and the address names of their public pages (24 November 2026): each branch has a stable `slug`,
 * the last part of its page address (`/bn/branches/lalmatia`), so a search for "the Lalmatia office" can land on that
 * office's own page and a QR code or an advertisement can point at one office.
 *
 * An admin may write the slug; a branch saved without one is given one from its English name (or `branch-2`, by its
 * place in the list, when it has no English name). The slug is stored once given, so renaming a branch later never
 * changes an address that Google or a printed code already knows.
 */

/** The most offices an agency can list. The consultation flow addresses an office by its place in this list. */
export const MAX_BRANCHES = 12;

/** Lowercase letters and digits in groups joined by single hyphens: it is part of a web address. */
export const BRANCH_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_SLUG_LENGTH = 60;

export const isBranchSlug = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= MAX_SLUG_LENGTH && BRANCH_SLUG.test(value);

/** Letters and digits of a name as a slug: accents removed, everything else a hyphen, at most 48 characters. */
export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
}

interface Sluggable {
  slug?: string | undefined;
  name?: { bn?: string | undefined; en?: string | undefined } | undefined;
}

/**
 * Every branch with a slug that is valid and unique in the list. A slug already there is kept (the first of two
 * equal ones keeps it); the others get one from their English name, then `-2`, `-3` ... until it is free.
 */
export function assignSlugs<T extends Sluggable>(branches: readonly T[]): (T & { slug: string })[] {
  const taken = new Set<string>();
  const kept = branches.map((branch) => {
    if (isBranchSlug(branch.slug) && !taken.has(branch.slug)) {
      taken.add(branch.slug);
      return branch.slug;
    }
    return null;
  });
  return branches.map((branch, index) => {
    const existing = kept[index];
    if (existing) return { ...branch, slug: existing };
    const base = slugify(branch.name?.en ?? '') || `branch-${index + 1}`;
    let slug = base;
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
    taken.add(slug);
    return { ...branch, slug };
  });
}

/**
 * Who runs a profile (22 October 2026), shown to the other family as a small label so they know who they are dealing
 * with: "managed by herself or himself", "by a parent", "by a sibling", "by a relative", "by someone else", or
 * "by the agency". It is always shown, whatever fields staff released, and it is only a label: no name, no contact.
 *
 * It is read from what registration already records: whether the agency entered the profile for a client (assisted),
 * and whom the person registering said the profile is for.
 */
export const OPERATORS = ['self', 'parent', 'sibling', 'relative', 'other', 'agency'] as const;
export type Operator = (typeof OPERATORS)[number];

const BY_RELATION: Record<string, Operator> = {
  self: 'self',
  // "child": the person registering is the profile's parent.
  child: 'parent',
  sibling: 'sibling',
  relative: 'relative',
  other: 'other',
};

export function operatorOf(serviceMode: string | null, managedFor: string | null): Operator {
  if (serviceMode === 'assisted') return 'agency';
  return BY_RELATION[managedFor ?? 'self'] ?? 'self';
}

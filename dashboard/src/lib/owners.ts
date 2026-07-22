// Human-owned tasks have been created under several assignee aliases over time
// ('steven', 'human', 'user', ...). They are one owner, so collapse them to a
// single canonical value: the board shows one name and the owner filter returns
// all of them instead of splitting into separate, mostly-empty entries.

const HUMAN_ALIASES = new Set(['human', 'user', 'steven', 'steve']);

export const HUMAN_OWNER_VALUE = 'human';
export const HUMAN_OWNER_LABEL = 'Steven';

// Lowercased alias list for building a SQL IN clause (assignee is compared
// case-insensitively so stored 'Steven'/'steven' both match).
export const HUMAN_ALIAS_LIST = [...HUMAN_ALIASES];

export function isHumanOwner(assignee?: string | null): boolean {
  return !!assignee && HUMAN_ALIASES.has(assignee.toLowerCase());
}

/** Canonical filter value for an assignee (human aliases collapse to 'human'). */
export function canonicalOwner(assignee?: string | null): string {
  if (!assignee) return '';
  return isHumanOwner(assignee) ? HUMAN_OWNER_VALUE : assignee;
}

/** Display label for an assignee on the board. */
export function ownerLabel(assignee?: string | null): string {
  if (!assignee) return '';
  return isHumanOwner(assignee) ? HUMAN_OWNER_LABEL : assignee;
}

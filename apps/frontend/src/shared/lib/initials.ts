// A person's initials for an avatar: the first letters of their first and last names.
export function initials(name: string, letters: 1 | 2 = 2): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.[0] ?? "?";
  const last = words.length > 1 ? (words.at(-1)?.[0] ?? "") : "";
  return (letters === 1 ? first : first + last).toUpperCase();
}

/** Join class names, skipping falsy values. Plain module so server and client components can both call it. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

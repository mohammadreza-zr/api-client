/**
 * Replaces `{key}` placeholders in a URL template.
 *
 * ```ts
 * applyUrlTemplate("/users/{id}/posts/{postId}", { id: 42, postId: 7 })
 * // "/users/42/posts/7"
 * ```
 */
export function applyUrlTemplate(
  template: Record<string, string | number>,
  url: string,
): string {
  let result = url;
  for (const [key, value] of Object.entries(template)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, "g"), String(value));
  }
  return result;
}
/** Small POSIX path helpers for the document viewer (the browser has no `node:path`). */

function normalize(parts: string[]): string[] {
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out;
}

export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

/** `rel` resolved against the absolute directory `dir` (`..` cannot climb above `/`). */
export function resolvePath(dir: string, rel: string): string {
  const parts = rel.startsWith("/") ? rel.split("/") : [...dir.split("/"), ...rel.split("/")];
  return `/${normalize(parts).join("/")}`;
}

/** `to` as a path relative to the absolute directory `from` (both absolute). */
export function relativePath(from: string, to: string): string {
  const a = normalize(from.split("/"));
  const b = normalize(to.split("/"));
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
}

/** True for `http:`, `mailto:`, `data:` and the like, and for `//host/...`. */
export function hasScheme(url: string): boolean {
  return /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(url);
}

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

export function isHtmlPath(path: string): boolean {
  return /\.html?$/i.test(path);
}

export function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(path);
}

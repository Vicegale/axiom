import type { LinkItem } from "../api";
import { hasScheme, isHtmlPath, isImagePath, isMarkdownPath } from "./paths";

/** An http(s) URL, or a GitHub "owner/repo#N" pull request, as an address; otherwise null. */
export function hrefOf(l: LinkItem): string | null {
  if (/^https?:\/\//.test(l.target)) return l.target;
  const pr = l.kind === "pr" ? /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(l.target) : null;
  return pr ? `https://github.com/${pr[1]}/pull/${pr[2]}` : null;
}

/** A spec, or an artifact that is a Markdown, HTML or image file, opens in the document viewer. */
export function viewable(l: LinkItem): boolean {
  if (hasScheme(l.target)) return false;
  if (l.kind === "spec") return isMarkdownPath(l.target);
  return (
    l.kind === "artifact" &&
    (isMarkdownPath(l.target) || isHtmlPath(l.target) || isImagePath(l.target))
  );
}

export type ArtifactKind = "html" | "image" | "markdown" | "external" | "file";

export function artifactKind(target: string): ArtifactKind {
  if (hasScheme(target)) return "external";
  if (isHtmlPath(target)) return "html";
  if (isImagePath(target)) return "image";
  if (isMarkdownPath(target)) return "markdown";
  return "file";
}

/** The file name of a path or URL (the host for a bare URL); the target itself as a last resort. */
export function fileName(target: string): string {
  let path = target;
  let host = "";
  if (/^https?:\/\//i.test(target)) {
    try {
      const u = new URL(target);
      path = u.pathname;
      host = u.host;
    } catch {}
  }
  const last = path.split(/[?#]/)[0]?.split("/").filter(Boolean).at(-1);
  return last || host || target;
}

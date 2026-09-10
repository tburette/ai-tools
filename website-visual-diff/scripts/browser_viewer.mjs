import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Change this constant to choose where relocated viewers are stored.
export const RELOCATED_VIEWER_ROOT = path.join(os.homedir(), "Downloads", "website-visual-diff");

function safeName(value) {
  return String(value)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "viewer";
}

export async function prepareBrowserViewer({ sourceDirectory, indexPath, token, relocate = true, viewerRoot = null }) {
  const absoluteSource = path.resolve(sourceDirectory);
  const absoluteIndex = path.resolve(indexPath);
  const relativeIndex = path.relative(absoluteSource, absoluteIndex);
  if (!relativeIndex || relativeIndex.startsWith(".." + path.sep) || path.isAbsolute(relativeIndex)) {
    throw new Error(`HTML viewer is not inside its report directory: ${absoluteIndex}`);
  }

  if (!relocate) {
    return {
      sourceDirectory: absoluteSource,
      directory: absoluteSource,
      indexPath: absoluteIndex,
      copied: false,
    };
  }

  const tokenName = safeName(token || `${Date.now()}-${process.pid}`);
  const configuredViewerRoot = viewerRoot
    ? path.resolve(viewerRoot)
    : process.env.WEBSITE_VISUAL_DIFF_VIEWER_ROOT
      ? path.resolve(process.env.WEBSITE_VISUAL_DIFF_VIEWER_ROOT)
      : RELOCATED_VIEWER_ROOT;
  const destination = path.join(configuredViewerRoot, `${safeName(path.basename(absoluteSource))}-${tokenName}`);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(absoluteSource, destination, { recursive: true, force: true });
  return {
    sourceDirectory: absoluteSource,
    directory: destination,
    indexPath: path.join(destination, relativeIndex),
    copied: true,
  };
}

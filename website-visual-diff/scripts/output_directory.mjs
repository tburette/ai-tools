import fs from "node:fs/promises";
import path from "node:path";

export async function ensureEmptyDirectory(directory, label = "Output directory") {
  const absoluteDirectory = path.resolve(directory);
  let entries;
  try {
    entries = await fs.readdir(absoluteDirectory);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error(`Could not inspect ${label.toLowerCase()} ${absoluteDirectory}: ${error.message}`, { cause: error });
    }
    await fs.mkdir(absoluteDirectory, { recursive: true });
    return absoluteDirectory;
  }

  if (entries.length) {
    throw new Error(
      `${label} must be new or empty: ${absoluteDirectory}. `
        + "Use a fresh directory, for example: mktemp -d /tmp/website-visual-diff.XXXXXX",
    );
  }
  return absoluteDirectory;
}

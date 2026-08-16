import fs from "node:fs/promises";
import path from "node:path";

async function ensurePrivateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return;
  try {
    await fs.chmod(directory, 0o700);
    const stats = await fs.stat(directory);
    if ((stats.mode & 0o077) !== 0) {
      throw new Error("owner-only permission check failed");
    }
  } catch (error) {
    // Some mounted filesystems do not implement POSIX permissions. Other
    // failures must be visible rather than leaving bearer state unprotected.
    if (["EINVAL", "ENOSYS", "EOPNOTSUPP"].includes(error?.code)) return;
    throw new Error("Could not enforce owner-only permissions for Web Inspector state", { cause: error });
  }
}

export function getProfileDirectory(stateRoot, profileName) {
  return path.join(stateRoot, profileName);
}

export async function prepareProfileDirectory(stateRoot, profileName) {
  await ensurePrivateDirectory(stateRoot);
  const profileDirectory = getProfileDirectory(stateRoot, profileName);
  let existing;
  try {
    existing = await fs.lstat(profileDirectory);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (existing?.isSymbolicLink()) {
    throw new Error(`Refusing to use symlinked Web Inspector profile directory "${profileName}"`);
  }
  if (existing && !existing.isDirectory()) {
    throw new Error(`Web Inspector profile "${profileName}" is not a directory`);
  }
  await ensurePrivateDirectory(profileDirectory);
  return profileDirectory;
}

export function profileLaunchError(profileName, error) {
  const message = String(error?.message ?? error);
  if (/already in use|singleton|lock(?: file|ed)?|user data directory.*(?:in use|locked)/i.test(message)) {
    return new Error(
      `Could not open Web Inspector profile "${profileName}". `
        + "The profile may already be in use; close the other browser session and retry.",
      { cause: error },
    );
  }
  return error;
}

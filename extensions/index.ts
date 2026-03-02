import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const SKILL_NAME = "tenzir";
const DEFAULT_TARBALL_URL =
  "https://github.com/tenzir/docs/releases/download/latest/tenzir-skill.tar.gz";
const DEFAULT_MAX_AGE_SECONDS = 24 * 3600;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000;

const skillTarballUrl =
  process.env.PI_TENZIR_SKILL_TARBALL_URL ??
  process.env.PI_TENZIR_DOCS_TARBALL_URL ??
  DEFAULT_TARBALL_URL;

const configuredMaxAgeSeconds = Number.parseInt(
  process.env.PI_TENZIR_SKILL_MAX_AGE_SECONDS ??
    process.env.PI_TENZIR_DOCS_MAX_AGE_SECONDS ??
    "",
  10,
);

const configuredDownloadTimeoutMs = Number.parseInt(
  process.env.PI_TENZIR_SKILL_DOWNLOAD_TIMEOUT_MS ??
    process.env.PI_TENZIR_DOCS_DOWNLOAD_TIMEOUT_MS ??
    "",
  10,
);

const skillMaxAgeSeconds =
  Number.isFinite(configuredMaxAgeSeconds) && configuredMaxAgeSeconds > 0
    ? configuredMaxAgeSeconds
    : DEFAULT_MAX_AGE_SECONDS;

const skillDownloadTimeoutMs =
  Number.isFinite(configuredDownloadTimeoutMs) &&
  configuredDownloadTimeoutMs > 0
    ? configuredDownloadTimeoutMs
    : DEFAULT_DOWNLOAD_TIMEOUT_MS;

interface SkillPaths {
  skillsRoot: string;
  skillDir: string;
  skillFile: string;
  lastSyncFile: string;
}

function getSkillPaths(cwd: string): SkillPaths {
  const cacheRoot =
    process.env.PI_TENZIR_CACHE_DIR ??
    (homedir()
      ? join(homedir(), ".pi", "agent", "cache", "pi-tenzir")
      : join(cwd, ".pi", "cache", "pi-tenzir"));
  const skillsRoot = join(cacheRoot, "skills");
  const skillDir = join(skillsRoot, SKILL_NAME);
  return {
    skillsRoot,
    skillDir,
    skillFile: join(skillDir, "SKILL.md"),
    lastSyncFile: join(skillDir, ".last-sync"),
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, skillDownloadTimeoutMs);

  try {
    return await fetch(url, { signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`download timed out after ${skillDownloadTimeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getRequestedSkillName(text: string): string | undefined {
  if (!text.startsWith("/skill:")) {
    return undefined;
  }

  const spaceIndex = text.indexOf(" ");
  return spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
}

async function getSyncState(
  paths: SkillPaths,
): Promise<{ hasSkill: boolean; needsSync: boolean }> {
  const hasSkill = await pathExists(paths.skillFile);
  if (!hasSkill) {
    return { hasSkill: false, needsSync: true };
  }
  if (!(await pathExists(paths.lastSyncFile))) {
    return { hasSkill: true, needsSync: true };
  }
  try {
    const rawTimestamp = await readFile(paths.lastSyncFile, "utf8");
    const lastSync = Number.parseInt(rawTimestamp.trim(), 10);
    if (!Number.isFinite(lastSync) || lastSync <= 0) {
      return { hasSkill: true, needsSync: true };
    }
    const ageSeconds = Math.floor(Date.now() / 1000) - lastSync;
    return { hasSkill: true, needsSync: ageSeconds >= skillMaxAgeSeconds };
  } catch {
    return { hasSkill: true, needsSync: true };
  }
}

async function syncSkill(pi: ExtensionAPI, paths: SkillPaths): Promise<void> {
  await mkdir(paths.skillsRoot, { recursive: true });

  const syncId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const tempDir = await mkdtemp(join(tmpdir(), "pi-tenzir-skill-"));
  const stagingDir = join(paths.skillsRoot, `${SKILL_NAME}.tmp-${syncId}`);
  const backupDir = join(paths.skillsRoot, `${SKILL_NAME}.bak-${syncId}`);
  const tarballPath = join(tempDir, "tenzir-skill.tar.gz");
  let hasBackup = false;

  try {
    const response = await fetchWithTimeout(skillTarballUrl);
    if (!response.ok) {
      throw new Error(`download failed with status ${response.status}`);
    }

    const archive = Buffer.from(await response.arrayBuffer());
    await writeFile(tarballPath, archive);

    await mkdir(stagingDir, { recursive: true });
    const extracted = await pi.exec("tar", [
      "-xzf",
      tarballPath,
      "-C",
      stagingDir,
    ]);
    if (extracted.code !== 0) {
      throw new Error(
        extracted.stderr ||
          extracted.stdout ||
          "failed to extract skill archive",
      );
    }

    if (!(await pathExists(join(stagingDir, "SKILL.md")))) {
      throw new Error("skill archive did not contain SKILL.md");
    }

    await writeFile(
      join(stagingDir, ".last-sync"),
      `${Math.floor(Date.now() / 1000)}\n`,
    );

    if (await pathExists(paths.skillDir)) {
      await rename(paths.skillDir, backupDir);
      hasBackup = true;
    }

    try {
      await rename(stagingDir, paths.skillDir);
    } catch (error) {
      if (hasBackup && (await pathExists(backupDir))) {
        await rename(backupDir, paths.skillDir).catch(() => {
          // Ignore rollback failures: caller will surface sync failure.
        });
      }
      throw error;
    }

    if (hasBackup) {
      await rm(backupDir, { recursive: true, force: true });
      hasBackup = false;
    }
  } finally {
    if (hasBackup) {
      await rm(backupDir, { recursive: true, force: true });
    }
    await rm(stagingDir, { recursive: true, force: true });
    await rm(tempDir, { recursive: true, force: true });
  }
}

const syncInFlightBySkillDir = new Map<string, Promise<boolean>>();
const syncErrorBySkillDir = new Map<string, string>();

function triggerSync(pi: ExtensionAPI, paths: SkillPaths): Promise<boolean> {
  const key = paths.skillDir;
  const inFlight = syncInFlightBySkillDir.get(key);
  if (inFlight) {
    return inFlight;
  }

  const syncPromise = syncSkill(pi, paths)
    .then(() => {
      syncErrorBySkillDir.delete(key);
      return true;
    })
    .catch((error) => {
      const errorMessage = formatError(error);
      syncErrorBySkillDir.set(key, errorMessage);
      console.warn(
        `[pi-tenzir] Failed to sync ${SKILL_NAME} skill: ${errorMessage}`,
      );
      return false;
    })
    .finally(() => {
      syncInFlightBySkillDir.delete(key);
    });

  syncInFlightBySkillDir.set(key, syncPromise);
  return syncPromise;
}

export default function (pi: ExtensionAPI) {
  pi.on("input", async (event, ctx) => {
    const requestedSkill = getRequestedSkillName(event.text);
    if (requestedSkill !== SKILL_NAME) {
      return { action: "continue" };
    }

    const paths = getSkillPaths(ctx.cwd);
    if (await pathExists(paths.skillFile)) {
      return { action: "continue" };
    }

    const inFlight = syncInFlightBySkillDir.has(paths.skillDir);
    const syncError = syncErrorBySkillDir.get(paths.skillDir);
    const message = inFlight
      ? "The Tenzir skill is still downloading. Please wait and run /reload."
      : syncError
        ? `Could not download the Tenzir skill: ${syncError}. Run /reload to retry.`
        : "The Tenzir skill is not available. Run /reload to retry downloading it.";

    if (ctx.hasUI) {
      ctx.ui.notify(message, "error");
    } else {
      console.error(`[pi-tenzir] ${message}`);
    }

    return { action: "handled" };
  });

  pi.on("resources_discover", async (event, ctx) => {
    const paths = getSkillPaths(event.cwd);
    const state = await getSyncState(paths);

    if (!state.hasSkill) {
      const synced = await triggerSync(pi, paths);
      if (!synced) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            "Could not download the Tenzir skill. Check your network connection and run /reload.",
            "warning",
          );
        }
        return {};
      }
    } else if (state.needsSync) {
      if (event.reason === "reload") {
        const synced = await triggerSync(pi, paths);
        if (!synced && ctx.hasUI) {
          ctx.ui.notify(
            "Could not refresh the Tenzir skill during reload. Using cached version.",
            "warning",
          );
        }
      } else {
        void triggerSync(pi, paths);
      }
    }

    if (await pathExists(paths.skillFile)) {
      return { skillPaths: [paths.skillFile] };
    }

    return {};
  });
}

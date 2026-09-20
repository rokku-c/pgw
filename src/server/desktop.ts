import { join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, rm, rename, chmod } from "node:fs/promises";
import { home, version } from "./config";

/**
 * The desktop shell is delivered separately from the npm package rather than
 * bundled into it.
 *
 * The shell embeds its own copy of the gateway as a Tauri sidecar, so shipping it
 * per-platform would roughly double each package (a 64 MB binary on top of an app
 * bundle that already contains one). Instead the npm package carries only the CLI
 * binary, and the shell is fetched from Releases on first use. That also makes
 * `PGW_NO_GUI=1` mean what it says: the bytes are never downloaded at all, rather
 * than downloaded and merely not used.
 */

const REPO = "rokku-c/pgw";
const APP_NAME = "Personal Gateway.app";
const APPIMAGE = "Personal Gateway.AppImage";

/** Release target keys, matching `scripts/build.ts` and the CI matrix. */
export function platformKey(): string | undefined {
  const { platform, arch } = process;
  if (platform !== "darwin" && platform !== "linux") return undefined;
  if (arch !== "arm64" && arch !== "x64") return undefined;
  return `${platform}-${arch}`;
}

export function desktopDir() {
  return join(home, "app");
}

/** Path to the installed shell, or undefined if it is not here yet. */
export function desktopApp(): string | undefined {
  if (process.env.PGW_NO_GUI === "1") return undefined;
  const override = process.env.PGW_APP;
  if (override) return existsSync(override) ? override : undefined;
  const candidate = process.platform === "darwin"
    ? join(desktopDir(), APP_NAME)
    : join(desktopDir(), APPIMAGE);
  return existsSync(candidate) ? candidate : undefined;
}

function archiveUrl(key: string) {
  return `https://github.com/${REPO}/releases/download/v${version}/pgw-desktop-${key}.tar.gz`;
}

/**
 * Download and unpack the desktop shell for this platform into `$PGW_HOME/app`.
 * Returns the path to the launched artifact.
 */
export async function installDesktop(log: (message: string) => void = console.error): Promise<string> {
  const key = platformKey();
  if (!key) throw new Error(`No desktop build for ${process.platform}-${process.arch}`);
  const url = archiveUrl(key);
  log(`Downloading the desktop app (${key})…`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status} — ${url}`);

  const dir = desktopDir();
  // Unpack into a staging dir and swap it in, so an interrupted download never
  // leaves a half-extracted app that later looks "installed" to desktopApp().
  const staging = `${dir}.staging`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  const archive = join(staging, "desktop.tar.gz");
  try {
    await Bun.write(archive, response);
    const tar = Bun.spawn(["tar", "-xzf", archive, "-C", staging], { stdout: "ignore", stderr: "inherit" });
    if ((await tar.exited) !== 0) throw new Error("Failed to unpack the desktop app");
    await rm(archive, { force: true });
    await rm(dir, { recursive: true, force: true });
    await rename(staging, dir);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }

  const app = process.platform === "darwin" ? join(dir, APP_NAME) : join(dir, APPIMAGE);
  if (!existsSync(app)) throw new Error(`Desktop app missing after unpack: ${app}`);
  // Executable bits sometimes do not survive a registry round-trip.
  if (process.platform !== "darwin") await chmod(app, 0o755);
  log(`Installed to ${app}`);
  return app;
}

// Tests that launch Playwright's `channel: "chrome"` need a real Google Chrome install.
// Skip them (with a reason) where it isn't installed, instead of failing on a missing binary.
import { existsSync } from "node:fs";
import { join } from "node:path";

function chromePaths() {
  if (process.platform === "darwin") return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  if (process.platform === "win32") {
    return [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"]]
      .filter(Boolean)
      .map((root) => join(root, "Google", "Chrome", "Application", "chrome.exe"));
  }
  return ["/opt/google/chrome/chrome"];
}

/** false when Google Chrome is installed; otherwise a skip reason for node:test. */
export function chromeSkip() {
  const paths = chromePaths();
  if (paths.some((p) => existsSync(p))) return false;
  return `needs Google Chrome (Playwright channel "chrome"); not found at ${paths.join(" or ")}`;
}

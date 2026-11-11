// Writes public/updates/<os>/latest.json for the promote workflow.
//   OS=darwin|linux|windows VERSION=1.0.1 [NOTES=…] [RELEASES_REPO=owner/repo] node scripts/promote.mjs
// darwin also needs the release's KnobDeck.app.tar.gz.sig (downloaded with `gh`), whose contents go
// into the manifest; tauri-plugin-updater checks it against the public key built into the app.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { OS, VERSION, NOTES = "", RELEASES_REPO = "HarshalKudale/knobdeck-releases" } = process.env;
if (!["darwin", "linux", "windows"].includes(OS)) throw new Error(`OS must be darwin, linux or windows, not ${OS}`);
const version = (VERSION ?? "").replace(/^v/, "");
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`VERSION must look like 1.0.1, not ${VERSION}`);
const tag = `v${version}`;
const page = `https://github.com/${RELEASES_REPO}/releases/tag/${tag}`;

let manifest = { version, notes: NOTES, pub_date: new Date().toISOString(), url: page };
if (OS === "darwin") {
  const asset = "KnobDeck.app.tar.gz";
  const dir = mkdtempSync(join(tmpdir(), "promote-"));
  execFileSync("gh", ["release", "download", tag, "--repo", RELEASES_REPO, "-p", `${asset}.sig`, "-D", dir], { stdio: "inherit" });
  const signature = readFileSync(join(dir, `${asset}.sig`), "utf8").trim();
  if (!signature) throw new Error(`${asset}.sig is empty`);
  manifest = { ...manifest, url: `https://github.com/${RELEASES_REPO}/releases/download/${tag}/${asset}`, signature };
}
mkdirSync(`public/updates/${OS}`, { recursive: true });
writeFileSync(`public/updates/${OS}/latest.json`, JSON.stringify(manifest, null, 2) + "\n");
console.log(`public/updates/${OS}/latest.json → ${version}`);

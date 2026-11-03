// Writes the plugins release's registry.json to public/plugins/registry.json and puts each plugin's readme
// (a release asset named in the registry) at public/plugins/<id>/readme.md, which is where the
// registry's readmeUrl points. Icons are not assets: iconUrl links the plugins repo directly.
//   node scripts/build-registry.mjs <dir with registry.json and the release's readme assets>
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SITE = "https://app.knobdeck.harshalkudale.com";
const assets = process.argv[2];
if (!assets) throw new Error("usage: build-registry.mjs <assets dir>");
const registry = JSON.parse(readFileSync(join(assets, "registry.json"), "utf8"));

rmSync("public/plugins", { recursive: true, force: true });
for (const p of registry.plugins) {
  if (!/^[a-z0-9-]+$/.test(p.id)) throw new Error(`bad plugin id: ${p.id}`);
  const target = join("public/plugins", p.id);
  mkdirSync(target, { recursive: true });
  if (p.readmeFile) copyFileSync(join(assets, p.readmeFile), join(target, "readme.md"));
}
// Point readmeUrl at this site whatever the release says, so older releases and a domain move still work.
for (const p of registry.plugins) p.readmeUrl = p.readmeFile ? `${SITE}/plugins/${p.id}/readme.md` : null;
writeFileSync("public/plugins/registry.json", `${JSON.stringify(registry, null, 2)}\n`);
console.log(`${registry.plugins.length} plugin(s) from ${registry.tag} -> public/plugins/registry.json`);

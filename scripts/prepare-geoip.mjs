// Copy geoip-lite's COUNTRY data files into .geoip/ (git-ignored). lib/geo points geoip-lite
// there via GEODATADIR; with no city files present it loads country data only (~6.5 MB of RAM
// instead of ~120 MB). Runs on install and before dev/build. Safe to run repeatedly.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const source = path.join(process.cwd(), "node_modules", "geoip-lite", "data");
const target = path.join(process.cwd(), ".geoip");
const files = ["geoip-country.dat", "geoip-country6.dat"];

if (!existsSync(path.join(source, files[0]))) {
  console.warn("[prepare-geoip] geoip-lite data not found; skipping (lookups will use the package's full data).");
  process.exit(0);
}
mkdirSync(target, { recursive: true });
for (const file of files) copyFileSync(path.join(source, file), path.join(target, file));
console.log(`[prepare-geoip] country data ready in .geoip/ (${files.join(", ")})`);

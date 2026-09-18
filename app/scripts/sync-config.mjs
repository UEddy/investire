// Copies the address book and the IDL into the app so Next can import them.
//
// Both are produced outside this package: devnet.json by
// scripts/setup-devnet.ts, the IDL by `anchor idl build`. Copying rather than
// reaching across the repo with a relative import keeps the Next module graph
// inside this directory, and means a Vercel build with the root set to app/
// still gets them, since Vercel clones the whole repo before running this.
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

const files = [
  [resolve(repoRoot, "devnet.json"), resolve(here, "..", "src/config/devnet.json")],
  [
    resolve(repoRoot, "target/idl/paritas.json"),
    resolve(here, "..", "src/config/paritas-idl.json"),
  ],
];

for (const [from, to] of files) {
  if (!existsSync(from)) {
    console.error(
      `sync-config: ${from} is missing.\n` +
        "  devnet.json comes from scripts/setup-devnet.ts\n" +
        "  target/idl/paritas.json comes from `anchor idl build`",
    );
    process.exit(1);
  }
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  console.log(`sync-config: ${from} -> ${to}`);
}

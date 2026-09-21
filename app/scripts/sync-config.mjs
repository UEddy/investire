// Copies the address book and the IDL into the app so Next can import them.
//
// Both are produced outside this package: devnet.json by
// scripts/setup-devnet.ts, the IDL by `anchor idl build`. Copying rather than
// reaching across the repo with a relative import keeps the Next module graph
// inside this directory.
//
// On a Vercel build this often finds nothing to copy, and that is expected
// rather than an error. The Git integration builds from GitHub, where target/
// is ignored and so the IDL is simply absent; a CLI deploy rooted at app/
// uploads neither source either, since both live outside this directory. Both
// cases land on the same fallback: the copies in src/config are committed, so
// there is always something already here to build from.
//
// Missing a source is only fatal when there is also no existing copy, because
// then the app genuinely has no addresses. That is what this used to hit on a
// clean clone, before the copies were committed.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

const files = [
  {
    what: "address book",
    from: resolve(repoRoot, "devnet.json"),
    to: resolve(here, "..", "src/config/devnet.json"),
    origin: "scripts/setup-devnet.ts",
    // The address book records the endpoint the environment was built
    // against. That field is stripped on the way in, because this file is
    // imported by client code and therefore ships to every visitor. Today it
    // holds a public endpoint and nothing is lost; the day somebody rebuilds
    // the environment against a provider url with a key in it, the key would
    // ride along into the bundle and quietly undo the /api/rpc proxy. The
    // browser gets its endpoint from the proxy, never from here.
    strip: ["rpcUrl"],
  },
  {
    what: "program IDL",
    from: resolve(repoRoot, "target/idl/paritas.json"),
    to: resolve(here, "..", "src/config/paritas-idl.json"),
    origin: "`anchor idl build`",
  },
];

let failed = false;

for (const { what, from, to, origin, strip } of files) {
  if (existsSync(from)) {
    mkdirSync(dirname(to), { recursive: true });
    if (strip?.length) {
      const parsed = JSON.parse(readFileSync(from, "utf8"));
      for (const field of strip) {
        delete parsed[field];
      }
      writeFileSync(to, `${JSON.stringify(parsed, null, 2)}\n`);
      console.log(`sync-config: refreshed ${what}, without ${strip.join(", ")}`);
    } else {
      copyFileSync(from, to);
      console.log(`sync-config: refreshed ${what}`);
    }
    continue;
  }

  if (existsSync(to)) {
    console.log(
      `sync-config: ${what} source not present, using the copy already here`,
    );
    continue;
  }

  console.error(
    `sync-config: no ${what}, and nothing to fall back on.\n` +
      `  expected ${from}, which comes from ${origin}`,
  );
  failed = true;
}

if (failed) {
  process.exit(1);
}

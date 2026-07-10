# builtinsea

An experiment in **bundling and distributing Node.js applications as single files** —
either as a small self-executing ZIP archive that runs on any installed Node, or as a
fully self-contained native executable that needs no Node at all.

It is driven by a modified Node.js, in two additions on top of Node's existing experimental
**virtual file system** (`node:vfs`, by Matteo Collina):

1. **ZIP archive support in `node:zlib`** plus a **`ZipProvider`** that mounts such an
   archive through VFS as a file tree — proposed upstream as
   [nodejs/node#64339](https://github.com/nodejs/node/pull/64339).
2. A **`--vfs` module loader** that resolves a program's entry point and all its
   `require()`/`import` against a mounted directory or archive — prepared as a follow-on in
   [pipobscure/node#3](https://github.com/pipobscure/node/pull/3).

Together they let the root a program runs from be a plain `.zip` embedded inside the
program's own file. Combined with Node's newer **Single Executable Application (SEA)**
tooling, this turns "an application plus its files" into "one file you can `chmod +x` and
run."

---

## Why this exists

Shipping a Node application to someone else is still awkward. The options today are all
compromises:

- **A directory of files + `npm install`.** The user needs the right Node, a working
  toolchain, and network access; `node_modules` is enormous and platform-specific for
  anything with native addons.
- **A bundler (esbuild/webpack/ncc).** Collapses JS into one file, but assets, addons,
  and anything that does `fs.readFile(__dirname + ...)` still leak out. You are shipping
  a JS blob, not an application.
- **`pkg` / SEA.** Produce a real executable, but historically SEA only took a **single
  CommonJS script**, code caching and asset handling were fiddly, and building one meant
  bolting a WASM copy of `postject` onto the side of your build to inject a blob into the
  binary.

The thing all of these dance around is that a real application is a *file tree*: an entry
point, sibling modules, a `package.json`, templates, static assets, maybe a native addon.
Node's module resolution and every `fs` call assume that tree lives on the real disk. If
you want to ship the tree *inside* a single file, you need Node to be able to treat
something-that-isn't-a-directory as the directory it resolves against.

That is exactly what the fork provides.

---

## What changed in node

Three layers matter here, and it's worth being precise about who wrote what and where each
one lives:

- **The `node:vfs` subsystem is pre-existing.** It was written and merged (as an
  experimental builtin) by **Matteo Collina** — not part of this work. It's summarized
  below only because it's the foundation everything else stands on.
- **The novel work is two additions to Node:**
  - **ZIP archive support in `node:zlib`** and the **`ZipProvider`** that mounts an archive
    through VFS — proposed upstream as
    [nodejs/node#64339](https://github.com/nodejs/node/pull/64339).
  - The **`--vfs` / `--vfs-manifest` module loader** that makes a mounted tree the thing a
    program actually resolves and runs from — prepared as a follow-on in
    [pipobscure/node#3](https://github.com/pipobscure/node/pull/3).
- **The SEA group** is recent upstream Node functionality the experiment leans on, carried
  along so the whole pipeline works from one binary.

### 0. Foundation (pre-existing): `node:vfs` — a virtual file system with pluggable providers

*By Matteo Collina; here for context, not part of this fork's contribution.* An experimental
builtin (`--experimental-vfs` to enable) exposing a `node:fs`-shaped API backed by a
swappable **provider**:

- **`MemoryProvider`** — an in-memory tree (the default); supports symlinks and watching,
  and can be frozen read-only.
- **`RealFSProvider`** — wraps a real directory and maps every VFS path under it,
  rejecting paths (and symlinks) that resolve outside the root. It gives a subtree *path
  containment* it wouldn't otherwise have.

The full synchronous / callback / promise surfaces of `fs` are mirrored, and `Stats`
objects are real `fs.Stats`. Crucially, the docs are explicit that **VFS is not a sandbox** —
it redirects supported `fs` calls whose resolved path falls under a mount; it is not a
security boundary. That honesty matters for how it's positioned below.

### 1. ZIP support in `node:zlib` *([nodejs/node#64339](https://github.com/nodejs/node/pull/64339))*

`node:zlib` gains a small archive toolkit:

- **`ZipEntry`** — one immutable archive member (name, metadata, content), created from a
  buffer or stream, or read back from raw bytes.
- **`ZipFile`** — a ZIP on disk, opened read-only by default (`{ writable: true }` to
  mutate), with get/add/delete/stream-by-name and `compact()` to reclaim deleted space.
- **`ZipBuffer`** — the fully in-memory equivalent, serializable back to a `Buffer`.
- **`createZipArchive()` / `...Sync()`** — build a fresh archive from a list of entries,
  returned as a `Readable` you can pipe straight to a file or socket.

Two details make the whole single-file trick possible:

- **`baseOffset`** — an archive records internal offsets; seeding them with a base offset
  lets the archive stay valid even when it is **not at byte 0 of its file** — e.g. when
  it's appended *after* a shebang line or after an entire Node binary.
- Read paths enforce content-size limits and reject malformed records (zip-bomb / corrupt
  input guards), with dedicated `ERR_ZIP_*` codes.

### 2. `ZipProvider` — a VFS provider backed by a ZIP archive *([nodejs/node#64339](https://github.com/nodejs/node/pull/64339))*

The bridge between the two: a provider for Matteo's `node:vfs` that exposes the entries of
a `ZipFile` (on disk) or `ZipBuffer` (in memory) as a browsable, read/write file tree.
Directories are recognized both explicitly and implicitly; a file opened for write commits
as a new archive entry when its handle is closed. This is what lets a `.zip` be *mounted*
and treated like a directory.

### 3. `--vfs` / `--vfs-manifest` startup flags — the keystone *([pipobscure/node#3](https://github.com/pipobscure/node/pull/3))*

This is what wires VFS into Node's *startup and module resolution* so a mounted tree
becomes the thing the program actually runs from:

- **`--vfs=<target>`** mounts a target and resolves the entry point *and all subsequent
  `require()` / `import`* against it instead of the real filesystem.
  - A **directory** target is mounted with `RealFSProvider` at its own real path.
  - A **file** target is opened as a read-only ZIP (`ZipFile`) and mounted with
    `ZipProvider` — turning that one file into a virtual directory.
- With `--vfs` active, `argv[1]` is *unconditionally the mount root*, exactly as if you
  had run `node <mountRoot>`. The mount's own `package.json` `"main"` decides what runs;
  a positional argument is the program's own argument (shifted to `argv[2]+`), never an
  entry-point override.
- That rule is precisely what makes a **self-mounting shebang** work:
  `#!/usr/bin/env -S node --vfs`. The kernel appends the script's own path as the value of
  `--vfs`, so the script mounts *itself* and runs its embedded `package.json` main.
- To make this real, four module-resolution primitives (package.json reading,
  nearest-scope lookup, legacy main resolution, extensionless format sniffing) were
  changed to stop calling native bindings directly and instead go through a VFS-aware path
  — deferring unchanged to the real bindings whenever no mount is active, so non-mounted
  behavior is identical.
- **Native addons** work: directory mounts `dlopen` the real file; archive mounts extract
  the addon to a per-pid, content-hashed temp file first (there is no real file to point
  at). **Worker threads** inherit the active mount, so sandboxed code can't spawn an
  "escaped" worker.

**`--vfs-manifest=<file>`** (used with a directory target) records the path of *every file
actually read through the mount* — by module resolution or by the program's own `fs`
calls. It's implemented as a small observer hook on the provider, not by patching methods.
This gives you a **dependency manifest by observation**: run the app once, and you get the
exact minimal set of files it touches — the correct contents for the archive you're about
to build.

### SEA support carried along

The fork also carries Node's newer SEA work so a single binary can build a SEA end-to-end:
`--build-sea <config.json>` generates a SEA directly from core (using LIEF instead of a
bolted-on WASM `postject`), plus **ESM entry-point support** in SEA (`"mainFormat"`) and
code-cache support for it. That's why `npm run sea` below is a single `node` invocation.

---

## The experiment in this repo

This repo is a minimal application (`lib/`) and a set of npm scripts that demonstrate two
end-to-end packaging pipelines built on the fork.

### The "application"

The bundled app is itself the tool that builds and checks these archives — it is at once
the **bundler**, the **verifier**, and an importable **library**:

```
lib/
  package.json   { "type":"module", "main":"app.js",
                   "exports": { ".":"./app.js", "./manifest":"./manifest.js" } }
  app.js         parseArgs CLI with `create` / `verify` subcommands; re-exports the library
  archive.js     createArchive() / bundle() — streams files, then signs the whole file
  manifest.js    buildManifest() / parseManifest() / verify() — signing + verification core
```

Packaging the verifier *as* one of these archives is the point: the same artifact that
carries an application can validate its own integrity, and `sea.js` reuses that same logic
to refuse to boot a tampered container (see [Signing and verification](#signing-and-verification)).

### The pieces

| File | Role |
|------|------|
| `lib/app.js` | The application. A `parseArgs` CLI (`create` / `verify`); also the SEA/`--vfs` entry point and the package's library root. |
| `lib/archive.js` | Bundler: writes a **prefix** (shebang stub or Node/SEA binary), then appends a ZIP of the listed files — each stamped with its content digest — with a `baseOffset` equal to the prefix size and an `AUTHORITY.PEM` manifest, then signs the whole file into the EOCD comment. |
| `lib/manifest.js` | The signing/verification core: `buildManifest(…)`, `parseManifest(…)` and `verify(source)`. |
| `sea.js` | The SEA program. **Verifies itself** (`process.argv[0]`, whole-file signature inlined from `manifest.js`), and only then opens it as a `ZipFile`, mounts it via `ZipProvider` at `/APP`, and `require`s the app. |
| `sea.json` | SEA build config: ESM-capable, runs with `--experimental-vfs`, outputs `node-base`. |
| `shell-base` | The shebang prefix: `#!/usr/bin/env -S node --no-warnings --experimental-vfs --vfs`. |
| `app.manifest` | The observed file list (from `--vfs-manifest`) that says what goes into the archive. |
| `certs/` | A self-signed test PKI (root CA + leaf, `gen.sh`) used to sign and trust the demo archives. |

### The scripts (`package.json`)

```jsonc
"sea":      "node --no-warnings --build-sea sea.json",
// Build a self-contained SEA Node binary (`node-base`) whose entry is sea.js.

"manifest": "node --no-warnings --experimental-vfs --vfs=lib/ --vfs-manifest app.manifest ./",
// Run the app with lib/ mounted, recording every file it actually reads into app.manifest.
// This *discovers* the archive's contents by observation instead of static analysis.

"archive":  "node --no-warnings lib/app.js create --base lib/ --prefix shell-base --key certs/leaf.key --chain certs/chain.pem < app.manifest > app.run && chmod 0755 app.run",
// Prefix = shell-base (shebang). Result: app.run — a tiny self-executing ZIP app, signed.

"executable":"node --no-warnings lib/app.js create --base lib/ --prefix node-base --key certs/leaf.key --chain certs/chain.pem < app.manifest > app.sea && chmod 0755 app.sea",
// Prefix = node-base (the SEA binary). Result: app.sea — a standalone executable, signed.

"verify":   "node --no-warnings lib/app.js verify --root certs/root.pem"
// Verify an archive against the test root, e.g. `npm run verify -- app.run`.
```

Drop `--key`/`--chain` from `create` to build an **unsigned** archive; drop `--root` from
`verify` to see how the same archive reads when its certificate isn't trusted.

### The two artifacts, and how each runs itself

**`app.run` — the shebang archive (~hundreds of bytes; needs Node installed).**
It is literally the `shell-base` shebang line followed by the ZIP of `lib/`. When executed,
the kernel runs `env node --vfs` and appends the file's own path. `--vfs` with no explicit
target therefore mounts **`app.run` itself** as a read-only ZIP, whose `package.json` main
(`app.js`) becomes the entry point. The archive's `baseOffset` was seeded to skip the
shebang bytes, so it stays a valid ZIP even though it doesn't start at byte 0. A whole
application in a file you can email — provided the recipient has a compatible Node.

**`app.sea` — the native executable (~155 MB; needs nothing).**
It is the SEA `node-base` binary followed by the same ZIP. Running it starts `sea.js`,
which opens `process.argv[0]` — the running executable — as a `ZipFile`, **verifies the
appended archive**, and only if it is fully valid and trusted mounts it at `/APP` and
requires the app out of it. No Node on the target, no `node_modules`, no extraction to disk
of the JS. The size is just "a Node runtime + your files," which is the honest floor for
*zero-dependency* distribution.

Because `sea.js` self-verifies before it will run, `./app.sea` **refuses to boot** unless the
embedded certificate chain is trusted. The demo signs with a self-signed test cert, so point
Node at the test root to trust it: `NODE_EXTRA_CA_CERTS=certs/root.pem ./app.sea`.

Same application, same archive format, two prefixes — one optimizing for **size**
(reuse the user's Node), one for **self-containment** (bring your own Node).

### Try it

```sh
npm run manifest     # observe which files the app reads  -> app.manifest
npm run archive      # build + sign the shebang archive   -> ./app.run
./app.run verify --root certs/root.pem app.sea   # verify some other archive -> VALID

npm run sea          # build the SEA base binary          -> ./node-base
npm run executable   # build + sign the standalone exe    -> ./app.sea
NODE_EXTRA_CA_CERTS=certs/root.pem ./app.sea verify app.run   # self-checks, then runs
./app.sea            # refuses: certificate not trusted (no NODE_EXTRA_CA_CERTS)
```

The app is a verifier, so it needs an archive to check. Note the `--vfs` launcher
(`app.run`) cannot verify **itself** by its own path — `--vfs` mounts the container over
that path, so it resolves to the archive's *interior*, not the raw bytes; verify any other
archive, or use the SEA, which mounts at `/APP` and *can* self-verify.

---

## Signing and verification

A single-file application is only as trustworthy as the bytes inside it. Building on the ZIP
toolkit, every archive this repo produces is protected by a **staged** scheme: one hash covers
the **whole file** (prefix included), the leaf certificate signs *that hash*, and both are
written into the archive's end-of-central-directory comment. Each **member** additionally
carries its own content digest. The staging is the point — a verifier can prove the bytes are
intact *before* it commits to anything (a cheap, cert-free gate), and only then spend a
certificate check. This is an application-level feature — it uses `node:zlib`'s
`ZipEntry`/`X509Certificate` primitives; it is not a change to Node.

### The `AUTHORITY.PEM` manifest

**The `AUTHORITY.PEM` manifest** is a normal archive entry that declares the algorithms and
carries the certificate chain — the signing authority. Its name is a real, extractable
filename, so a plain zip utility can pull it out for auditing:

```
!manifest 2                        magic + format version
!hash sha256                       digest used for the whole-file hash and member digests
!sign sha256                       digest the signature (over that hash) uses
                                   (blank line — present only when signed)
-----BEGIN CERTIFICATE-----        full PEM chain, leaf first, embedded so a
…                                  verifier is self-contained
-----END CERTIFICATE-----
```

**Every member** (every entry except the manifest) also records the hex digest of its own
content in its ZIP **entry comment**, computed with `!hash`.

### The whole-file hash, and a signature over it

One hash covers the *entire file* — the prepended launcher or Node/SEA binary, every member,
the complete central directory (member digests included) and the fixed part of the EOCD
record — up to but **excluding the EOCD's 2-byte comment-length field**. The EOCD must be the
last structure in the file, so the hashed region is simply everything before its trailing
comment. The leaf certificate then signs **that hash** (not the file), and the EOCD comment —
which the hash deliberately stops short of — records both:

```
SIGNED:<hash-of-region-hex>:<signature-hex>
```

Signing the hash rather than the file is what makes the stages cheap: a verifier hashes the
file once, matches it against `<hash>`, and can then check `<signature>` over that same hash
without touching the file again. Because the hash spans the whole file, nothing — a byte of
the runtime prefix, a member's bytes, a recorded digest in the central directory, the
algorithm lines, or the embedded chain — can be altered without changing it. The per-member
digests are that guarantee applied one file at a time, so an individual extracted member can
be checked on its own (and a member fetch can re-verify it).

### The four verification states

`verify()` runs the stages in order and reports exactly one state:

| State | Meaning |
|-------|---------|
| **unsigned** | no `AUTHORITY.PEM` manifest, or no `SIGNED:…` marker in the EOCD comment |
| **invalid** | the recomputed hash doesn't match the recorded one, the signature doesn't verify over it, **or** a member's recorded digest doesn't match its content |
| **valid-untrusted** | hash + signature + digests are sound, but the certificate chain isn't anchored in the trust store |
| **valid** | all of the above sound **and** the chain is trusted |

The whole scheme is gated on the `SIGNED:` marker: only a signed archive is checked at all.
Because the hash covers the central directory, it fixes *which* members exist and every
member's digest, so editing *any* byte after signing yields **invalid**. Trust is evaluated
against the system CA store **plus** `NODE_EXTRA_CA_CERTS` (and any extra roots passed to
`verify`), so the trusted path is testable without touching the OS store.

### The library

`lib/` doubles as an importable package (the intended reuse point for the loader):

```js
import { buildManifest, verify } from 'test-app/manifest';

// build the AUTHORITY.PEM manifest content (algorithms + chain); the whole-file
// signature is applied by bundle(), not here
const content = buildManifest({ hashAlg: 'sha256', signAlg: 'sha256', chain });

// verify an archive path or a Buffer of the whole file
const { state, reason, subject } = await verify('app.run', { extraRoots });
```

### Self-verifying the SEA

`sea.js` is a single CommonJS file that runs *before* the archive is mounted, so it cannot
`import` the library — the verification logic is copied into it, and it makes the staging
concrete:

1. **precheck** — hash `process.argv[0]` (itself, prefix and all) and match it to the recorded
   hash. This is cert-free and runs **before mounting**; a tampered container is refused here.
2. **mount** — only a hash-intact container is mounted via `ZipProvider` at `/APP`.
3. **authenticate** — verify the signature over that hash against the chain in `AUTHORITY.PEM`
   and anchor it in the trust store.
4. **run** — `require` the app only once the container is `valid` *and* trusted.

An unsigned, tampered, or untrusted container exits non-zero without ever running. This split
is deliberate groundwork: a future `ZipProvider` can fold the per-member digest checks into
member fetches (erroring before it closes a member's stream on a hash mismatch), and the
`--vfs` loader can *require* a signature outright. (The `--vfs` shebang launcher has no
pre-mount stage today, so `app.run` does not self-verify — it hands straight off to the app.)

---

## Why these changes to Node make sense

The through-line is: **let a single file be the file tree a program runs from.**

- **Distribution wants one artifact, but applications are trees.** ZIP is the obvious
  container for a tree, and `baseOffset` is the one small primitive that lets a ZIP live
  *inside* another file — after a shebang, after a binary — without ceasing to be a valid
  ZIP. That is what makes "append and go" possible instead of "carve out a section and
  inject with a separate tool."
- **Resolution has to believe the tree.** Bundlers fail at the edges because they rewrite
  *some* module loading but the rest of Node — legacy main resolution, `package.json`
  lookup, extension sniffing, and every user `fs.readFile` — still points at the real disk.
  Routing those primitives through a VFS-aware layer (that is a no-op when nothing is
  mounted) means the *whole* runtime, not just the bundler's slice, agrees on where files
  are. Assets and addons come along for free.
- **The self-mounting shebang is the elegant payoff.** Because `--vfs`'s no-target case
  mounts the invoked script itself, a plain executable ZIP with a one-line header behaves
  like an installed program — no launcher, no wrapper, no unpacking. It's the Python
  zipapp / self-extracting-jar idea, but resolved natively by the runtime rather than
  bootstrapped by user code.
- **The manifest closes the "what do I even ship?" problem.** Static dependency analysis is
  perennially wrong for dynamic `require`, data files, and conditional imports.
  `--vfs-manifest` answers it empirically: *these are the files this run touched.* Combined
  with the mount, build-time discovery and run-time resolution use the same mechanism.
- **SEA is the second delivery mode, not a different world.** By carrying `--build-sea`,
  ESM SEA entry points, and their code cache, the *same* archive that powers `app.run` also
  powers `app.sea`. You choose "small, needs Node" vs. "large, needs nothing" per target
  without changing how you package.

### Honest limitations

- **VFS is not a sandbox.** It redirects `fs`; it does not confine untrusted code. Real
  isolation still needs OS-level mechanisms. The fork's own docs say so.
- **Native SEAs are large** because they include a full Node. That's inherent to
  zero-dependency native distribution, not a flaw in the approach.
- **Everything here is experimental** — a personal fork, `--experimental-vfs`, `REPLACEME`
  version markers. It's a proof of concept for a distribution model, not a supported
  product.

---

## Layout

```
builtinsea/
  lib/            the app: bundler + verifier + importable library
    app.js          parseArgs CLI (create / verify); SEA + --vfs entry; library root
    archive.js      createArchive() / bundle(): prefix + zip(baseOffset), whole-file signature
    manifest.js     buildManifest() / parseManifest() / verify(): the signing + verification core
    package.json    { type:module, main:app.js, exports: { ".", "./manifest" } }
  sea.js          SEA bootstrap: verify self (whole-file signature), then mount and require the app
  sea.json        --build-sea configuration
  shell-base      shebang prefix for the portable archive
  certs/          self-signed test PKI (root CA + leaf) and gen.sh
  app.manifest    observed file list (produced by `npm run manifest`)
  app.run         built: self-executing ZIP app (needs Node)
  app.sea         built: standalone executable (needs nothing)
  package.json    the sea / manifest / archive / executable / verify scripts
```

Build outputs (`app`, `app.manifest`, `app.run`, `app.sea`, `node-base`) are generated by
the scripts above.

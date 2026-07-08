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

```
lib/
  package.json   { "type":"module", "main":"app.js" }
  app.js         imports ./other.js, logs its text
  other.js       exports a string
```

Deliberately trivial — the point is the *packaging*, not the app. `other.js` exists only to
prove that sibling-module resolution works *through the mount*, not just the single entry file.

### The pieces

| File | Role |
|------|------|
| `sea.js` | The SEA program. Opens **itself** (`process.argv[0]`) as a `ZipFile`, mounts it via `ZipProvider` at `/APP`, and `require`s the app. |
| `sea.json` | SEA build config: ESM-capable, runs with `--experimental-vfs`, outputs `node-base`. |
| `archive.js` | Builds a runnable file: writes a **prefix** (a shebang stub or a Node/SEA binary), then appends a ZIP of the listed files with a `baseOffset` equal to the prefix size. |
| `shell-base` | The shebang prefix: `#!/usr/bin/env -S node --no-warnings --experimental-vfs --vfs`. |
| `app.manifest` | The observed file list (from `--vfs-manifest`) that says what goes into the archive. |

### The scripts (`package.json`)

```jsonc
"sea":      "node --no-warnings --build-sea sea.json",
// Build a self-contained SEA Node binary (`node-base`) whose entry is sea.js.

"manifest": "node --no-warnings --experimental-vfs --vfs=lib/ --vfs-manifest app.manifest ./",
// Run the app with lib/ mounted, recording every file it actually reads into app.manifest.
// This *discovers* the archive's contents by observation instead of static analysis.

"archive":  "node --no-warnings archive.js lib/ shell-base < app.manifest > app.run && chmod 0755 app.run",
// Prefix = shell-base (shebang). Result: app.run — a tiny self-executing ZIP app.

"executable":"node --no-warnings archive.js lib/ node-base < app.manifest > app.sea && chmod 0755 app.sea"
// Prefix = node-base (the SEA binary). Result: app.sea — a standalone executable.
```

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
which opens `process.argv[0]` — the running executable — as a `ZipFile`, mounts the
appended archive at `/APP`, and requires the app out of it. No Node on the target, no
`node_modules`, no extraction to disk of the JS. The size is just "a Node runtime + your
files," which is the honest floor for *zero-dependency* distribution.

Same application, same archive format, two prefixes — one optimizing for **size**
(reuse the user's Node), one for **self-containment** (bring your own Node).

### Try it

```sh
npm run manifest     # observe which files the app reads  -> app.manifest
npm run archive      # build the shebang archive          -> ./app.run
./app.run            # prints "this is the text"

npm run sea          # build the SEA base binary          -> ./node-base
npm run executable   # build the standalone executable    -> ./app.sea
./app.sea            # prints "this is the text"
```

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
  lib/            the sample application (entry + sibling module + package.json)
  sea.js          SEA bootstrap: mount self as ZIP, require the app
  sea.json        --build-sea configuration
  archive.js      prefix + zip(baseOffset) archive builder
  shell-base      shebang prefix for the portable archive
  app.manifest    observed file list (produced by `npm run manifest`)
  app.run         built: self-executing ZIP app (needs Node)
  app.sea         built: standalone executable (needs nothing)
  package.json    the sea / manifest / archive / executable scripts
```

Build outputs (`app`, `app.manifest`, `app.run`, `app.sea`, `node-base`) are generated by
the scripts above.
```

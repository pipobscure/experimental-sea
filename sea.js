const ZLIB = require('node:zlib');
const VFS = require('node:vfs');
const MOD = require('node:module');
const FS = require('node:fs');
const CRYPTO = require('node:crypto');
const TLS = require('node:tls');

// ---------------------------------------------------------------------------
// Archive verification, inlined from lib/manifest.js.
//
// A SEA main is a single CommonJS script that runs *before* the archive is
// mounted, so it cannot import the bundled library — the code it needs is
// copied here and specialised to a filesystem path (the container's own).
//
// The scheme is staged: one hash covers the whole file (everything up to the
// EOCD comment), the leaf certificate signs that hash, and both are recorded in
// the EOCD comment as `SIGNED:<hash>:<sig>`. Each member also carries its own
// content digest in its ZIP entry comment. See lib/manifest.js for the full
// write-up.
// ---------------------------------------------------------------------------

const AUTHORITY = 'AUTHORITY.PEM';
const SIG_EOCD = 0x06054b50;

// Stage 1 — the pre-mount integrity gate. Read the algorithms and chain from
// AUTHORITY.PEM and the `SIGNED:<hash>:<sig>` marker from the EOCD comment, then
// recompute the whole-file hash and confirm it matches the recorded one. This
// touches no trust store and is all a caller needs before it dares mount. On
// success it hands back the recorded hash and the material stage 2 needs.
async function precheck(path) {
    const size = FS.statSync(path).size;

    const zf = ZLIB.ZipFile.openSync(path);
    const authority = zf.has(AUTHORITY) ? zf.getSync(AUTHORITY) : undefined;
    if (!authority) return { state: 'unsigned', reason: 'no manifest entry' };
    const { hashAlg, signAlg, chain } = parseManifest(authority.contentSync());

    const eocd = locateEocd(readTail(path, size), size);
    const marker = parseSignature(eocd.comment.toString('ascii'));
    if (!signAlg || chain.length === 0 || !marker) {
        return { state: 'unsigned', reason: 'manifest carries no signature' };
    }

    let digest;
    try {
        const hash = CRYPTO.createHash(hashAlg);
        await feed(path, eocd.start + 20, hash); // up to, and excluding, the comment-length field
        digest = hash.digest('hex');
    } catch {
        digest = null;
    }
    if (digest !== marker.hash) {
        return { state: 'invalid', reason: 'archive hash does not match the recorded hash', chain };
    }
    return { state: 'ok', hash: marker.hash, sig: marker.sig, signAlg, chain };
}

// Stage 2 — authenticity. The recorded hash (already validated in stage 1) must
// be signed by the leaf certificate, and the chain must anchor in the trust
// store. Signing the hash rather than the file means this needs no second read.
function authenticate({ hash, sig, signAlg, chain }, { extraRoots, now = Date.now() } = {}) {
    let signatureOk = false;
    try {
        signatureOk = CRYPTO.verify(signAlg, Buffer.from(hash, 'hex'), chain[0].publicKey, Buffer.from(sig, 'hex'));
    } catch {
        signatureOk = false;
    }
    if (!signatureOk) return result('invalid', 'signature does not verify against leaf certificate', chain);

    const roots = trustRoots(extraRoots);
    const ok = anchored(chain, roots, now);
    return result(ok ? 'valid' : 'valid-untrusted',
        ok ? 'trusted certificate chain' : 'certificate chain not anchored in the trust store',
        chain);
}

function readTail(path, size) {
    const len = Math.min(size, 22 + 0xffff);
    const buf = Buffer.alloc(len);
    const fd = FS.openSync(path, 'r');
    try { FS.readSync(fd, buf, 0, len, size - len); } finally { FS.closeSync(fd); }
    return buf;
}

function feed(path, end, sink) {
    return new Promise((resolve, reject) => {
        FS.createReadStream(path, { start: 0, end: end - 1 })
            .on('data', (chunk) => sink.update(chunk))
            .on('error', reject)
            .on('end', resolve);
    });
}

// Find the end-of-central-directory record in `tail` (the last bytes of a file
// of total length `size`) and return { start, comment } with `start` absolute.
function locateEocd(tail, size) {
    const floor = Math.max(0, tail.length - (22 + 0xffff));
    const scan = (exact) => {
        for (let pos = tail.length - 22; pos >= floor; pos--) {
            if (tail.readUInt32LE(pos) !== SIG_EOCD) continue;
            const end = pos + 22 + tail.readUInt16LE(pos + 20);
            if (exact ? end !== tail.length : end > tail.length) continue;
            return pos;
        }
        return -1;
    };
    let pos = scan(true);
    if (pos < 0) pos = scan(false);
    if (pos < 0) throw new Error('no end of central directory record found');
    const clen = tail.readUInt16LE(pos + 20);
    return { start: size - tail.length + pos, comment: tail.subarray(pos + 22, pos + 22 + clen) };
}

function parseManifest(content) {
    const text = Buffer.isBuffer(content) ? content.toString('utf-8') : String(content);
    const split = text.indexOf('\n\n');
    const head = split >= 0 ? text.slice(0, split) : text;
    const pem = split >= 0 ? text.slice(split + 2) : '';
    const directives = {};
    for (const line of head.split('\n')) {
        if (!line || line[0] !== '!') continue;
        const sp = line.indexOf(' ');
        if (sp < 0) directives[line.slice(1)] = '';
        else directives[line.slice(1, sp)] = line.slice(sp + 1);
    }
    const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
    const chain = blocks.map((block) => new CRYPTO.X509Certificate(block));
    return { version: directives.manifest, hashAlg: directives.hash || 'sha256', signAlg: directives.sign, chain };
}

function parseSignature(comment) {
    const m = /^SIGNED:([0-9a-f]+):([0-9a-f]+)$/i.exec(comment);
    return m ? { hash: m[1].toLowerCase(), sig: m[2].toLowerCase() } : null;
}

function result(state, reason, chain) {
    return {
        state,
        reason,
        subject: chain && chain[0] ? chain[0].subject : undefined,
        signed: state !== 'unsigned',
        trusted: state === 'valid',
    };
}

function trustRoots(extra) {
    const pems = [...cas('system'), ...cas('extra'), ...(extra || [])];
    return pems.map((pem) => new CRYPTO.X509Certificate(pem));
}

function cas(type) {
    try {
        return TLS.getCACertificates(type) || [];
    } catch {
        return [];
    }
}

function within(cert, now) {
    return Date.parse(cert.validFrom) <= now && now <= Date.parse(cert.validTo);
}

// Path validation: every link in the supplied chain must be issuer-signed and
// in-date, and the top of the chain must be, or be issued by, a trusted root.
function anchored(chain, roots, now) {
    for (const cert of chain) if (!within(cert, now)) return false;
    for (let i = 0; i < chain.length - 1; i++) {
        if (!chain[i].checkIssued(chain[i + 1])) return false;
        if (!chain[i].verify(chain[i + 1].publicKey)) return false;
    }
    const top = chain[chain.length - 1];
    for (const root of roots) {
        if (top.fingerprint256 === root.fingerprint256) return true;
        if (top.checkIssued(root) && top.verify(root.publicKey) && within(root, now)) return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Boot: an integrity gate, then mount, then an authenticity gate, then run.
//
//   1. precheck  — recompute the whole-file hash and match it to the recorded
//                  one. Cheap, cert-free; refuse before mounting on a mismatch.
//   2. mount     — make the (now proven-intact) container the app's filesystem.
//   3. authenticate — verify the signature over that hash against the chain in
//                  AUTHORITY.PEM and anchor it in the trust store.
//   4. run       — only once the container is valid *and* trusted.
//
// The gate is on the signature marker: an unsigned container never reaches the
// checks (and, here, never runs). A future ZipProvider will fold the per-member
// hash checks into member fetches, and the --vfs loader can require a signature.
// ---------------------------------------------------------------------------

function refuse(state, reason) {
    console.error(`refusing to run: archive is not valid (${state}) — ${reason}`);
    process.exit(1);
}

(async () => {
    const pre = await precheck(process.argv[0]);
    if (pre.state !== 'ok') refuse(pre.state, pre.reason);

    const archive = ZLIB.ZipFile.openSync(process.argv[0]);
    const provider = new VFS.ZipProvider(archive);
    const vfs = VFS.create(provider);
    vfs.mount('/APP');

    const res = authenticate(pre);
    if (res.state !== 'valid') refuse(res.state, res.reason);

    MOD.createRequire('/APP/package.json')('./');
})();

import * as ZLIB from 'node:zlib';
import * as CRYPTO from 'node:crypto';
import * as TLS from 'node:tls';
import * as FS from 'node:fs';

// The signature is staged so a verifier can gate cheaply before doing more:
//
//   * Integrity — a single hash covers the *entire file*: the prepended
//     launcher/binary, every member, the whole central directory (member
//     comments included) and the fixed part of the end-of-central-directory
//     record, up to but excluding the EOCD's 2-byte comment-length field. The
//     EOCD must be the last thing in the file, so the hashed region is simply
//     everything before its trailing comment.
//
//   * Authenticity — the leaf certificate signs that hash (not the file), so
//     once the hash is known the signature check needs no re-read of the file.
//
//   * Per-member integrity — every member also carries the hex digest of its
//     own content in its ZIP entry comment, the same guarantee applied one file
//     at a time (and what a per-member fetch check would re-verify).
//
// Both are recorded in the EOCD comment — which the whole-file hash stops short
// of — as a single marker:
//
//   SIGNED:<hash-of-region-hex>:<signature-hex>
//
// A verifier can validate the hash on its own (a pre-mount integrity gate),
// then check the signature over that hash against the certificate, and only a
// signed archive (one carrying this marker) is gated at all.
//
// The manifest is the `AUTHORITY.PEM` member: it declares the algorithms and
// carries the certificate chain (the signing authority) — hence the name, which
// is also a real, extractable filename a plain zip utility will happily pull
// out when auditing:
//
//   !manifest 2                     <- magic + format version
//   !hash sha256                    <- digest for the whole-file hash and members
//   !sign sha256                    <- digest the signature (over that hash) uses
//                                   <- blank line (present only when signed)
//   -----BEGIN CERTIFICATE-----     <- full PEM chain, leaf first, embedded so
//   ...                                a verifier is self-contained

const MAGIC = 'manifest';
const VERSION = '2';
export const AUTHORITY = 'AUTHORITY.PEM';
const SIG_EOCD = 0x06054b50;

// Build the manifest content from the algorithms and (when signing) the
// certificate chain. Returns a Buffer.
//
//   buildManifest({ hashAlg, signAlg, chain })
//     hashAlg - digest for the whole-file hash and member digests (default 'sha256')
//     signAlg - digest the signature over that hash uses; omit for an unsigned
//               manifest
//     chain   - full PEM certificate chain, leaf first; omit for unsigned
export function buildManifest({ hashAlg = 'sha256', signAlg, chain } = {}) {
    let body = `!${MAGIC} ${VERSION}\n!hash ${hashAlg}\n`;
    const signing = Boolean(signAlg && chain);
    if (signing) body += `!sign ${signAlg}\n\n` + String(chain).replace(/\s*$/, '') + '\n';
    return Buffer.from(body, 'utf-8');
}

// Split manifest bytes into { version, hashAlg, signAlg, chain }.
export function parseManifest(content) {
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
    return {
        version: directives[MAGIC],
        hashAlg: directives.hash || 'sha256',
        signAlg: directives.sign,
        chain,
    };
}

// Verify an archive. `source` is a filesystem path (opened read-only and
// streamed) or a Buffer of the whole file. Resolves to
// { state, reason, subject, signed, trusted } where state is one of:
//   'unsigned'        - no manifest, or a manifest without a signature
//   'invalid'         - signature fails, or a member's digest doesn't match
//   'valid-untrusted' - signature + digests sound, chain not in the trust store
//   'valid'           - signature + digests sound and the chain is trusted
//
// opts.extraRoots  - additional trusted PEM roots (besides system + NODE_EXTRA_CA_CERTS)
// opts.now         - reference time for certificate validity (default: now)
export async function verify(source, { extraRoots, now = Date.now() } = {}) {
    const io = Buffer.isBuffer(source) ? bufferSource(source) : pathSource(source);

    const zf = io.open();
    const present = new Map();
    for (const [name, entry] of zf.entriesSync()) present.set(name, entry);

    const authority = present.get(AUTHORITY);
    if (!authority) return result('unsigned', 'no manifest entry');

    const { hashAlg, signAlg, chain } = parseManifest(authority.contentSync());

    // The signature lives in the EOCD comment as `SIGNED:<hash>:<sig>`; the
    // region the hash covers ends just before the comment's length field.
    const eocd = locateEocd(io.tail(), io.size);
    const marker = parseSignature(eocd.comment.toString('ascii'));
    if (!signAlg || chain.length === 0 || !marker) {
        return result('unsigned', 'manifest carries no signature');
    }
    const regionEnd = eocd.start + 20; // up to, and excluding, the comment-length field

    // 1. Integrity (the cheap pre-mount gate): recompute the whole-file hash
    //    and confirm it matches the hash recorded in the comment. No certs yet.
    let digest;
    try {
        const hash = CRYPTO.createHash(hashAlg);
        await io.feed(hash, regionEnd);
        digest = hash.digest('hex');
    } catch {
        digest = null;
    }
    if (digest !== marker.hash) return result('invalid', 'archive hash does not match the recorded hash', chain);

    // 2. Authenticity: the recorded hash must be signed by the leaf certificate.
    //    Because the signature is over the hash, this needs no re-read of the file.
    let signatureOk = false;
    try {
        signatureOk = CRYPTO.verify(signAlg, Buffer.from(marker.hash, 'hex'), chain[0].publicKey, Buffer.from(marker.sig, 'hex'));
    } catch {
        signatureOk = false;
    }
    if (!signatureOk) return result('invalid', 'signature does not verify against leaf certificate', chain);

    // 3. Per-member integrity: every member's recorded digest must match its
    //    recomputed content digest. (The whole-file hash already fixes every
    //    member; this checks each file on its own terms, as a member fetch will.)
    for (const [name, entry] of present) {
        if (name === AUTHORITY) continue;
        const recorded = entry.comment || '';
        if (!recorded) return result('invalid', `member carries no digest: ${name}`, chain);
        let memberDigest;
        try {
            const hash = CRYPTO.createHash(hashAlg);
            for await (const chunk of entry.contentIterator()) hash.update(chunk);
            memberDigest = hash.digest('hex');
        } catch {
            return result('invalid', `member could not be read: ${name}`, chain);
        }
        if (memberDigest !== recorded) return result('invalid', `digest mismatch: ${name}`, chain);
    }

    // 4. Signature and digests are sound; trust is decided by the chain.
    const roots = trustRoots(extraRoots);
    const ok = anchored(chain, roots, now);
    return result(ok ? 'valid' : 'valid-untrusted',
        ok ? 'trusted certificate chain' : 'certificate chain not anchored in the trust store',
        chain);
}

// Parse an EOCD comment of the form `SIGNED:<hash-hex>:<signature-hex>` into
// { hash, sig }, or null when the archive is unsigned (no such marker).
export function parseSignature(comment) {
    const m = /^SIGNED:([0-9a-f]+):([0-9a-f]+)$/i.exec(comment);
    return m ? { hash: m[1].toLowerCase(), sig: m[2].toLowerCase() } : null;
}

// A path-backed source: statable size, a tail read for the EOCD, a streamed
// hash feed for the signed region, and a ZipFile opener.
function pathSource(path) {
    const size = FS.statSync(path).size;
    return {
        size,
        tail() {
            const len = Math.min(size, 22 + 0xffff);
            const buf = Buffer.alloc(len);
            const fd = FS.openSync(path, 'r');
            try { FS.readSync(fd, buf, 0, len, size - len); } finally { FS.closeSync(fd); }
            return buf;
        },
        feed(sink, end) {
            return new Promise((resolve, reject) => {
                FS.createReadStream(path, { start: 0, end: end - 1 })
                    .on('data', (chunk) => sink.update(chunk))
                    .on('error', reject)
                    .on('end', resolve);
            });
        },
        open: () => openArchive(path),
    };
}

// A Buffer-backed source: the whole file is already in memory.
function bufferSource(buf) {
    return {
        size: buf.length,
        tail: () => buf.subarray(Math.max(0, buf.length - (22 + 0xffff))),
        feed: (sink, end) => { sink.update(buf.subarray(0, end)); return Promise.resolve(); },
        open: () => new ZLIB.ZipBuffer(buf),
    };
}

// Find the end-of-central-directory record in `tail` (the last bytes of a file
// of total length `size`) and return { start, comment } with `start` absolute.
// The EOCD must be the last structure in the file, so its comment runs to EOF.
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

function openArchive(path) {
    try {
        return ZLIB.ZipFile.openSync(path);
    } catch (err) {
        // When run from the `--vfs` shebang launcher, the container mounts its
        // own path as a live filesystem, so that path resolves to the archive's
        // interior (a directory) rather than the raw container bytes. Opening it
        // as a ZIP then fails deep inside with a confusing message.
        let isDir = false;
        try { isDir = FS.statSync(path).isDirectory(); } catch { /* fall through */ }
        if (isDir) {
            throw new Error(`cannot verify '${path}': it is mounted as a live filesystem ` +
                `(the running container cannot read its own container bytes by path — ` +
                `verify it under a different name)`);
        }
        throw err;
    }
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

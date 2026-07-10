import * as ZLIB from 'node:zlib';
import * as CRYPTO from 'node:crypto';
import * as TLS from 'node:tls';
import * as FS from 'node:fs';

// The manifest is the archive's `*` entry. Its content is signed text; its
// ZIP entry comment carries the detached signature (base64). Layout:
//
//   !manifest 1                     <- magic + format version
//   !alg sha256                     <- digest for file hashes AND the signature
//   <name> <hexdigest>              <- one line per archive entry (name may
//   ...                                contain spaces; the digest never does)
//                                   <- blank line (present only when signed)
//   -----BEGIN CERTIFICATE-----     <- full PEM chain, leaf first, embedded so
//   ...                                a verifier is self-contained
//
// The signature covers the entire content (chain included), so the algorithm,
// the file digests and the certificates cannot be altered without breaking it.

const MAGIC = 'manifest';
const VERSION = '1';

// Build the manifest content and its detached signature from a map of
// archive-entry-name -> hex digest.
//
//   sign(hashmap, { alg, key, chain })
//     alg   - digest for the file hashes and the signature (default 'sha256')
//     key   - private key of the leaf certificate (PEM/DER/KeyObject); omit to
//             produce an unsigned manifest
//     chain - full PEM certificate chain, leaf first
//
// Returns { content: Buffer, comment: string }; `comment` is '' when unsigned.
export function sign(hashmap, { alg = 'sha256', key, chain } = {}) {
    let body = `!${MAGIC} ${VERSION}\n!alg ${alg}\n`;
    for (const [name, hash] of hashmap) body += `${name} ${hash}\n`;
    const signing = Boolean(key && chain);
    if (signing) body += '\n' + String(chain).replace(/\s*$/, '') + '\n';
    const content = Buffer.from(body, 'utf-8');
    const comment = signing ? CRYPTO.sign(alg, content, key).toString('base64') : '';
    return { content, comment };
}

// Verify an archive. `archive` is a path (opened read-only) or an already-open
// ZipFile/ZipBuffer. Resolves to { state, reason, subject, signed, trusted }
// where state is one of:
//   'unsigned'        - no manifest, or a manifest without a signature
//   'invalid'         - signature fails, or the manifest doesn't cover the archive
//   'valid-untrusted' - signature + coverage sound, chain not in the trust store
//   'valid'           - signature + coverage sound and the chain is trusted
//
// opts.extraRoots  - additional trusted PEM roots (besides system + NODE_EXTRA_CA_CERTS)
// opts.now         - reference time for certificate validity (default: now)
export async function verify(archive, { extraRoots, now = Date.now() } = {}) {
    const zf = typeof archive === 'string' ? openArchive(archive) : archive;

    const present = new Map();
    for (const [name, entry] of zf.entriesSync()) present.set(name, entry);

    const star = present.get('*');
    if (!star) return result('unsigned', 'no manifest entry');

    const content = star.contentSync();
    const comment = star.comment || '';
    const { directives, files, chain } = parse(content);
    if (!comment || chain.length === 0) return result('unsigned', 'manifest carries no signature');

    const alg = directives.alg || 'sha256';

    // 1. Signature must verify against the leaf certificate over the exact
    //    manifest bytes (chain included).
    let signatureOk = false;
    try {
        signatureOk = CRYPTO.verify(alg, content, chain[0].publicKey, Buffer.from(comment, 'base64'));
    } catch {
        signatureOk = false;
    }
    if (!signatureOk) return result('invalid', 'signature does not verify against leaf certificate', chain);

    // 2. Coverage: the manifest must describe exactly the archive's entries
    //    (minus the manifest itself), and every recomputed digest must match.
    const names = new Set([...present.keys()].filter((n) => n !== '*'));
    for (const n of files.keys()) if (!names.has(n)) return result('invalid', `manifest lists a missing entry: ${n}`, chain);
    for (const n of names) if (!files.has(n)) return result('invalid', `archive has an unlisted entry: ${n}`, chain);
    for (const [name, entry] of present) {
        if (name === '*') continue;
        let digest;
        try {
            const hash = CRYPTO.createHash(alg);
            for await (const chunk of entry.contentIterator()) hash.update(chunk);
            digest = hash.digest('hex');
        } catch {
            return result('invalid', `entry could not be read: ${name}`, chain);
        }
        if (digest !== files.get(name)) return result('invalid', `digest mismatch: ${name}`, chain);
    }

    // 3. Signature and coverage are sound; trust is decided by the chain.
    const roots = trustRoots(extraRoots);
    const ok = anchored(chain, roots, now);
    return result(ok ? 'valid' : 'valid-untrusted',
        ok ? 'trusted certificate chain' : 'certificate chain not anchored in the trust store',
        chain);
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

// Split manifest bytes into { directives, files, chain }.
function parse(content) {
    const text = Buffer.isBuffer(content) ? content.toString('utf-8') : String(content);
    const split = text.indexOf('\n\n');
    const head = split >= 0 ? text.slice(0, split) : text;
    const pem = split >= 0 ? text.slice(split + 2) : '';
    const directives = {};
    const files = new Map();
    for (const line of head.split('\n')) {
        if (!line) continue;
        if (line[0] === '!') {
            const sp = line.indexOf(' ');
            if (sp < 0) directives[line.slice(1)] = '';
            else directives[line.slice(1, sp)] = line.slice(sp + 1);
        } else {
            const sp = line.lastIndexOf(' '); // names may contain spaces; the digest cannot
            if (sp > 0) files.set(line.slice(0, sp), line.slice(sp + 1));
        }
    }
    const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
    const chain = blocks.map((block) => new CRYPTO.X509Certificate(block));
    return { directives, files, chain };
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

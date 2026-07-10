const SEA = require('node:sea');
const ZLIB = require('node:zlib');
const VFS = require('node:vfs');
const PATH = require('node:path');
const MOD = require('node:module');
const FS = require('node:fs');
const CRYPTO = require('node:crypto');
const TLS = require('node:tls');

// ---------------------------------------------------------------------------
// Archive verification, inlined from lib/manifest.js.
//
// A SEA main is a single CommonJS script that runs *before* the archive is
// mounted, so it cannot import the bundled library — the code it needs is
// copied here and adapted to operate on the already-open ZipFile.
// ---------------------------------------------------------------------------

async function verify(zf, { extraRoots, now = Date.now() } = {}) {
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

function result(state, reason, chain) {
    return {
        state,
        reason,
        subject: chain && chain[0] ? chain[0].subject : undefined,
        signed: state !== 'unsigned',
        trusted: state === 'valid',
    };
}

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

// ---------------------------------------------------------------------------
// Boot: verify the container, then mount and run it only if the certificate
// chain is fully valid and trusted. Any other state refuses to run.
// ---------------------------------------------------------------------------

(async () => {
    const archive = ZLIB.ZipFile.openSync(process.argv[0]);
    const res = await verify(archive);
    if (res.state !== 'valid') {
        console.error(`refusing to run: archive is not valid (${res.state}) — ${res.reason}`);
        process.exit(1);
    }

    const provider = new VFS.ZipProvider(archive);
    const vfs = VFS.create(provider);
    vfs.mount('/APP');
    MOD.createRequire('/APP/package.json')('./');
})();

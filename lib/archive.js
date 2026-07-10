import * as ZLIB from 'node:zlib';
import * as PATH from 'node:path';
import * as FS from 'node:fs';
import * as CRYPTO from 'node:crypto';
import { Transform } from 'node:stream';
import { buildManifest, AUTHORITY } from './manifest.js';

// Yields a ZipEntry per file — each stamped, in its entry comment, with the hex
// digest of its own content — then a final `AUTHORITY.PEM` manifest entry
// declaring the algorithms and (when signing) carrying the certificate chain.
// Members are small (an application's own files; the heavy runtime is the prepended
// prefix, not an archive member), so each is read whole to hash it before the
// entry, whose comment must be fixed at creation time, is built.
async function *entries(base, files, { hashAlg, signAlg, chain }) {
    for (const item of files) {
        const data = FS.readFileSync(PATH.resolve(base, item));
        const digest = CRYPTO.createHash(hashAlg).update(data).digest('hex');
        yield await ZLIB.ZipEntry.create(item, data, { mode: 0o444, comment: digest });
    }
    yield await ZLIB.ZipEntry.create(AUTHORITY, buildManifest({ hashAlg, signAlg, chain }), { mode: 0o444 });
}

// Returns a Readable of the ZIP archive over `files` (relative to `base`). Its
// members carry per-file digests and its AUTHORITY.PEM manifest declares the
// algorithms and chain, but the archive itself is left with an empty EOCD
// comment: the whole-file hash and its signature are a property of the finished
// file and are applied by `bundle()`. `baseOffset` seeds the archive's internal
// offsets for when it is appended after a prefix.
export function createArchive({ base, files, hashAlg = 'sha256', signAlg, chain, baseOffset = 0 }) {
    const items = entries(base, files, { hashAlg, signAlg, chain });
    return ZLIB.createZipArchive(items, { baseOffset });
}

// Writes `prefix` then the archive to `out`, without closing `out`. When `key`
// and `chain` are given, the whole file is signed. The hash runs over the
// prefix and then over the archive up to (but not including) the EOCD comment;
// that hash is what the leaf key signs. The EOCD comment records both, so a
// verifier can validate the hash on its own (a cheap pre-mount integrity gate)
// and only then check the signature over that hash against the certificate:
//
//   SIGNED:<hash-of-region-hex>:<signature-hex>
//
// Returns when the file has been fully written.
export async function bundle({ base, files, prefix, hashAlg = 'sha256', signAlg = 'sha256', key, chain, out }) {
    const signing = Boolean(key && chain);
    const hasher = signing ? CRYPTO.createHash(hashAlg) : null;

    // 1. Stream the prefix straight to `out`, feeding the whole-file hash.
    await prepend(prefix, out, hasher);

    // 2. Build the archive (small) with an empty EOCD comment, in memory.
    const archive = await collect(createArchive({
        base, files, hashAlg,
        signAlg: signing ? signAlg : undefined,
        chain: signing ? chain : undefined,
        baseOffset: FS.statSync(prefix).size,
    }));

    if (!signing) return void await write(out, archive);

    // 3. The signed region is the prefix plus the archive minus its trailing
    //    2-byte (empty) comment-length field. Hash it, sign the hash, and
    //    re-emit the archive with `SIGNED:<hash>:<sig>` as the EOCD comment.
    const region = archive.subarray(0, archive.length - 2);
    hasher.update(region);
    const digest = hasher.digest();
    const signature = Buffer.from(CRYPTO.sign(signAlg, digest, key)).toString('hex');
    const comment = Buffer.from(`SIGNED:${digest.toString('hex')}:${signature}`, 'ascii');
    const length = Buffer.alloc(2);
    length.writeUInt16LE(comment.length, 0);
    await write(out, Buffer.concat([region, length, comment]));
}

function prepend(file, out, sink) {
    return new Promise((resolve, reject) => {
        const tap = new Transform({
            transform(chunk, _enc, cb) { if (sink) sink.update(chunk); cb(null, chunk); },
        });
        FS.createReadStream(file).on('error', reject)
            .pipe(tap).on('error', reject).on('end', resolve)
            .pipe(out, { end: false });
    });
}

async function collect(readable) {
    const chunks = [];
    for await (const chunk of readable) chunks.push(chunk);
    return Buffer.concat(chunks);
}

function write(out, buffer) {
    return new Promise((resolve, reject) => out.write(buffer, (err) => err ? reject(err) : resolve()));
}

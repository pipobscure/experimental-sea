import * as ZLIB from 'node:zlib';
import * as PATH from 'node:path';
import * as FS from 'node:fs';
import * as CRYPTO from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { sign } from './manifest.js';

// Yields a ZipEntry per file (hashing its content on the fly into `hashmap`),
// then a final `*` manifest entry built and signed from the completed hashmap.
// The archive serializes entries in order, so every file's stream has been
// drained — and its digest recorded — by the time the manifest is produced.
async function *entries(base, files, hashmap, signing) {
    for (const item of files) {
        const source = PATH.resolve(base, item);
        const hash = CRYPTO.createHash('sha256');
        const stream = FS.createReadStream(source).pipe(new Transform({
            transform(chunk, _enc, cb) { hash.update(chunk); cb(null, chunk); },
            flush(cb) { hashmap.set(item, hash.digest('hex')); cb(); },
        }));
        yield await ZLIB.ZipEntry.createStream(item, stream, { mode: 0o444 });
    }
    const { content, comment } = sign(hashmap, signing);
    yield await ZLIB.ZipEntry.createStream('*', Readable.from([content]), { mode: 0o444, comment });
}

// Returns a Readable of the ZIP archive over `files` (relative to `base`),
// terminated by a `*` manifest that is signed when `key` + `chain` are given.
// `baseOffset` seeds the archive's internal offsets for when it is appended
// after a prefix (a shebang launcher or a whole Node binary).
export function createArchive({ base, files, key, chain, baseOffset = 0, comment = 'node:app' }) {
    const hashmap = new Map();
    const items = entries(base, files, hashmap, { key, chain });
    return ZLIB.createZipArchive(items, { comment, baseOffset });
}

// Writes `prefix` then the archive to `out`, without closing `out`. Returns
// when the archive has been fully written.
export async function bundle({ base, files, prefix, key, chain, out, comment }) {
    const baseOffset = await prepend(prefix, out);
    await drain(createArchive({ base, files, key, chain, baseOffset, comment }), out);
}

function prepend(file, out) {
    return new Promise((resolve, reject) => {
        FS.createReadStream(file)
            .on('error', reject)
            .on('end', () => resolve(FS.statSync(file).size))
            .pipe(out, { end: false });
    });
}

function drain(readable, out) {
    return new Promise((resolve, reject) => {
        readable.on('error', reject).on('end', resolve).pipe(out, { end: false });
    });
}

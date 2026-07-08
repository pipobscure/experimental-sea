import * as ZLIB from 'node:zlib';
import * as PATH from 'node:path';
import * as FS from 'node:fs';

const base = PATH.resolve(process.cwd(), process.argv[2] ?? './');
const pref = PATH.resolve(process.cwd(), process.argv[3] ?? 'shell-base');
async function *lines(stream) {
    let rest = '';
    for await (const chunk of stream) {
        const lines = (rest+chunk).split(/\r?\n/);
        while (lines.length > 1) {
            yield lines.shift();
        }
        rest = lines.shift();
    }
    if (rest) yield rest;
}
async function *unique(items) {
    const set = new Set();
    for await (const item of items) {
        if (!set.has(item)) yield item;
        set.add(item);
    }
}
async function *entries(items) {
    for await (const item of items) {
        const source = PATH.resolve(base, item);
        console.error(`${source} -> ${item}`);
        const stream = FS.createReadStream(source);
        yield await ZLIB.ZipEntry.createStream(item, stream, { mode: 0o444 });
    }
}
async function prepend(file, stream) {
    const def = Promise.withResolvers();
    const source = FS.createReadStream(file);
    source.on('end', def.resolve).on('error', def.reject).pipe(stream);
    await def.promise;
    return FS.statSync(file).size;
}
async function append(source, stream) {
    const def = Promise.withResolvers();
    source.on('end', def.resolve).on('error', def.reject).pipe(stream);
    await def.promise;
}

async function main() {
    const base = await prepend(pref, process.stdout);
    process.stdin.setEncoding('utf-8');
    const files = await Array.fromAsync(unique(lines(process.stdin)));
    const items = entries(files.sort());
    await append(ZLIB.createZipArchive(items, { comment: 'node:app', baseOffset: base }), process.stdout);
    process.stdout.end();
}

main();
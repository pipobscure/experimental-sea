const SEA = require('node:sea');
const ZLIB = require('node:zlib');
const VFS = require('node:vfs');
const PATH = require('node:path');
const MOD = require('node:module');
const FS = require('node:fs');


const buffer = SEA.getRawAsset('app');
const archive = new ZLIB.ZipBuffer(buffer);
const provider = new VFS.ArchiveProvider(archive);
const vfs = VFS.create(provider);

vfs.mount('/APP');
MOD.createRequire('/APP/package.json')('./');

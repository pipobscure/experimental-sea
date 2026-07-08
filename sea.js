const SEA = require('node:sea');
const ZLIB = require('node:zlib');
const VFS = require('node:vfs');
const PATH = require('node:path');
const MOD = require('node:module');
const FS = require('node:fs');

const archive = ZLIB.ZipFile.openSync(process.argv[0]);
const provider = new VFS.ZipProvider(archive);
const vfs = VFS.create(provider);

vfs.mount('/APP');
MOD.createRequire('/APP/package.json')('./');

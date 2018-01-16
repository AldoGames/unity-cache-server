const assert = require('assert');
const tmp = require('tmp');
const loki = require('lokijs');
const fs = require('fs-extra');
const sleep = require('./test_utils').sleep;
const generateCommandData = require('./test_utils').generateCommandData;
const EventEmitter = require('events');

let test_modules = [
    {
        name: "cache_membuf",
        path: "../lib/cache/cache_membuf",
        options: {
            cachePath: tmp.tmpNameSync({}),
            initialPageSize: 10000,
            growPageSize: 10000,
            minFreeBlockSize: 1024,
            persistenceOptions: {
                adapter: new loki.LokiMemoryAdapter()
            }
        }
    },
    {
        name: "cache_fs",
        path: "../lib/cache/cache_fs",
        options: {
            cachePath: tmp.tmpNameSync({})
        }
    }
];

describe("Cache API", () => {
    test_modules.forEach(module => {
        describe(module.name, () => {
            let CacheModule, cache;

            before(() => {
                /** @type {CacheBase} **/
                CacheModule = require(module.path);
                cache = new CacheModule();
            });

            after(() => {
                return fs.remove(module.options.cachePath);
            });

            describe("static get properties", () => {
                it("should return an object with common property values", () => {
                    let props = CacheModule.properties;
                    assert(props.hasOwnProperty('clustering') && typeof(props['clustering']) === 'boolean');
                });
            });

            describe("init", () => {
                it("should create the cache working directory if it doesn't exist", () => {
                    return cache.init(module.options)
                        .then(() => fs.access(module.options.cachePath));
                });
            });

            describe("registerClusterWorker", () => {
                it("should return with no error", done => {
                    cache.registerClusterWorker(new EventEmitter());
                    done();
                });
            });

            describe("shutdown", () => {
                it("should return with no error", () => {
                    return cache.shutdown();
                });
            });

            describe("createPutTransaction", () => {
                let fileData;

                before(() => {
                    fileData = generateCommandData(1024, 1024);
                });

                it("should return a PutTransaction object for the given file hash & guid", () => {
                    return cache.createPutTransaction(fileData.guid, fileData.hash)
                        .then(trx => {
                                assert(trx.guid.compare(fileData.guid) === 0);
                                assert(trx.hash.compare(fileData.hash) === 0);
                        });
                });
            });

            describe("endPutTransaction & getFileInfo", () => {
                let fileData, trx;

                beforeEach(() => {
                    fileData = generateCommandData(1024, 1024);
                    return cache.createPutTransaction(fileData.guid, fileData.hash)
                        .then(result => { trx = result; });
                });

                it("should call finalize on the transaction", () => {
                    let called = false;
                    trx.finalize = () => {
                        called = true;
                        return Promise.resolve();
                    };

                    cache.endPutTransaction(trx).then(() => assert(called));
                });

                it("should add info, asset, and resource files to the cache that were written to the transaction", () => {
                    return trx.getWriteStream('i', fileData.info.length)
                        .then(stream => stream.end(fileData.info))
                        .then(() => cache.endPutTransaction(trx))
                        .then(() => cache.getFileInfo('i', fileData.guid, fileData.hash))
                        .then(info => assert(info.size === fileData.info.length));
                });

                it("should return an error if any files were partially written to the transaction", () => {
                    return trx.getWriteStream('i', fileData.info.length)
                        .then(stream => stream.end(fileData.info.slice(0, 1)))
                        .then(() => cache.endPutTransaction(trx))
                        .then(() => { throw new Error("Expected error!"); }, err =>  assert(err));
                });

                it("should not add files to the cache that were partially written to the transaction", () => {
                    return trx.getWriteStream('i', fileData.info.length)
                        .then(stream => stream.end(fileData.info.slice(0, 1)))
                        .then(() => cache.endPutTransaction(trx))
                        .then(() => {}, err => assert(err))
                        .then(() => cache.getFileInfo('i', fileData.guid, fileData.hash))
                        .then(() => { throw new Error("Expected error!"); }, err =>  assert(err));
                });
            });

            describe("getFileStream", function() {

                let fileData;

                beforeEach(() => {
                    fileData = generateCommandData(1024, 1024);
                    let trx;
                    return cache.createPutTransaction(fileData.guid, fileData.hash)
                        .then(result => { trx = result; })
                        .then(() => trx.getWriteStream('i', fileData.info.length))
                        .then(stream => stream.end(fileData.info))
                        .then(() => cache.endPutTransaction(trx))
                        .then(() => sleep(50));
                });

                it("should return a readable stream for a file that exists in the cache", () => {
                    return cache.getFileStream('i', fileData.guid, fileData.hash)
                        .then(stream => assert(stream instanceof require('stream').Readable));
                });

                it("should return an error for a file that does not exist in the cache", () => {
                    return cache.getFileStream('a', fileData.guid, fileData.hash)
                        .then(() => { throw new Error("Expected error!"); }, err =>  assert(err));
                });
            });
        });
    });
});

describe("PutTransaction API", function() {
    test_modules.forEach(function (module) {
        describe(module.name, function () {
            let cache, fileData, trx;

            before(() => {
                /** @type {CacheBase} **/
                let CacheModule = require(module.path);
                cache = new CacheModule();
                fileData = generateCommandData(1024, 1024);
            });

            after(() => {
                return fs.remove(module.options.cachePath);
            });

            beforeEach(() => {
                return cache.createPutTransaction(fileData.guid, fileData.hash)
                    .then(result => { trx = result; });
            });

            describe("get guid", function() {
                it("should return the file guid for the transaction", () => {
                    assert(trx.guid === fileData.guid);
                });
            });

            describe("get hash", function() {
                it("should return the file hash for the transaction", () => {
                    assert(trx.hash === fileData.hash);
                });
            });

            describe("get files", function() {
                it("should return an empty array before finalize() is called", () => {
                    assert(trx.files.length === 0);
                });

                it("should return a list of objects that represent completed files for the transaction", () => {
                    return trx.getWriteStream('i', fileData.info.length)
                        .then(stream => stream.end(fileData.info))
                        .then(() => trx.finalize())
                        .then(() => assert(trx.files.length === 1));
                });
            });

            describe("finalize", function() {
                it("should return an error if any file was not fully written", () => {
                    return trx.getWriteStream('i', fileData.info.length)
                        .then(stream => stream.end(fileData.info.slice(0, 1)))
                        .then(() => trx.finalize())
                        .then(() => { throw new Error("Expected error!"); }, err =>  assert(err));
                });

                it("should return with no error and no value if the transaction was successfully finalized", () => {
                    return trx.getWriteStream('i', fileData.info.length)
                        .then(stream => stream.end(fileData.info))
                        .then(() => trx.finalize())
                });

                it("should emit a 'finalize' event", (done) => {
                    trx.once('finalize', () => done());
                    trx.finalize();
                });
            });

            describe("getWriteStream", function() {
                it("should return a WritableStream for the given file type", () => {
                    return trx.getWriteStream('i', 1)
                        .then(stream => assert(stream instanceof require('stream').Writable));
                });

                it("should only accept types of 'i', 'a', or 'r", () => {
                    return trx.getWriteStream('i', 1)
                        .then(() => trx.getWriteStream('a', 1))
                        .then(() => trx.getWriteStream('r', 1))
                        .then(() => trx.getWriteStream('x', 1))
                        .then(() => { throw new Error("Expected error!"); }, err => assert(err));
                });

                it("should return an error for size equal to 0", () => {
                    return trx.getWriteStream('i', 0)
                        .then(() => { throw new Error("Expected error!"); }, err => assert(err))
                });

                it("should return an error for size less than 0", () => {
                    return trx.getWriteStream('i', -1)
                        .then(() => { throw new Error("Expected error!"); }, err => assert(err))
                });
            });
        });
    });
});
/**
 * ! Need two extra files in this directory: commercialCreds.json and govCreds.json for this script to work.
 * ! Along the lines of the following info in it.
{
    "accessKeyId": "ACCESSKEY",
    "secretAccessKey": "SECRTEKEYsecretkeySECRETKEY"
}
 */

const arg = require('arg');
const EventEmitter = require('events');
class DownloadEmitter extends EventEmitter {}
const { auto, queue, doWhilst, each } = require('async');
const { v4: uuidv4 } = require('uuid');
const { tmpdir } = require('os');
const aws = require('aws-sdk');
const fs = require('fs-extra');
const { basename, join } = require('path');
const s3Upload = require('s3-upload-resume');
const inquirer = require('inquirer');
const sqlite3 = require('sqlite3').verbose();

const commCreds = new aws.Credentials(require('./commercialCreds.json'));
const govCreds = new aws.Credentials(require('./govCreds.json'));

const govEndPoint = new aws.Endpoint('s3-fips.us-gov-east-1.amazonaws.com');

const commS3 = new aws.S3({ apiVersion: '2006-03-01', region: 'us-east-1', signatureVersion: 'v4', credentials: commCreds });
const govS3 = new aws.S3({ apiVersion: '2006-03-01', region: 'us-gov-east-1', endpoint: govEndPoint, signatureVersion: 'v4', credentials: govCreds });

const s3UploadClient = s3Upload.createClient({
    multipartUploadThreshold: 5 * 1024 * 1024,
    multipartUploadSize: 5 * 1024 * 1024,
    s3Client: govS3,
});

const downloadQ = queue((task, cb) => {
    const downloadEmitter = new DownloadEmitter();
    downloadEmitter.once('error', (err) => cb(err));

    const params = {
        Bucket: task.s3Bucket,
        Key: task.s3Key,
    };
    const fileStream = fs.createWriteStream(task.downloadPath);
    const s3Stream = commS3.getObject(params).createReadStream();

    s3Stream.on('error', (err) => downloadEmitter.emit('error', err));

    s3Stream
        .pipe(fileStream)
        .on('error', (err) => downloadEmitter.emit('error', err))
        .on('close', (data) => cb(null, data));
}, 1);

const uploadQ = queue((task, cb) => {
    const params = {
        localFile: task.uploadPath,

        s3Params: {
            Bucket: task.s3Bucket,
            Key: task.s3Key,
        },
    };

    console.dir(params, { depth: null, colors: true });
    console.dir(s3UploadClient, { depth: null, colors: true });

    const upload = s3UploadClient.uploadFile(params);

    upload.on('error', (err) => cb(err));

    upload.on('end', (data) => cb(null, data));
}, 1);

const filesInPrefixOnCommercial = (bucket, prefix, cb) => {
    let keys = [];
    let token;
    let isTruncated = false;

    function sortByProperty(property) {
        return function (x, y) {
            return x[property] === y[property] ? 0 : x[property] > y[property] ? 1 : -1;
        };
    }

    const list = (obj, callback) => {
        // console.dir(obj, { depth: null, colors: true });
        callback = typeof obj === 'function' ? obj : callback;
        callback = typeof callback === 'function' ? callback : () => {};
        token = obj.token ? obj.token : null;
        bucket = obj.bucket ? obj.bucket : null;
        prefix = obj.prefix ? obj.prefix : null;

        const params = {
            Bucket: bucket,
            ContinuationToken: token,
            Prefix: prefix,
        };

        commS3.listObjectsV2(params, callback);
    };

    doWhilst(
        (next) => {
            list({ token, bucket, prefix }, (err, result) => {
                if (err) return next(err);
                if (result.IsTruncated) token = result.NextContinuationToken;
                isTruncated = result.IsTruncated;
                each(
                    result.Contents,
                    (row, cont) => {
                        row.Bucket = bucket;
                        row.Base = basename(row.Key);
                        keys.push(row);
                        cont();
                    },
                    (eachErr) => {
                        if (eachErr) return next(eachErr);
                        next();
                    }
                );
            });
        },
        (cb) => cb(null, isTruncated),
        (err, result) => {
            if (err) return cb(err);
            keys = keys.sort(sortByProperty('Key'));
            cb(null, keys);
        }
    );
};

const filesInPrefixOnGov = (bucket, prefix, cb) => {
    let keys = [];
    let token;
    let isTruncated = false;

    function sortByProperty(property) {
        return function (x, y) {
            return x[property] === y[property] ? 0 : x[property] > y[property] ? 1 : -1;
        };
    }

    const list = (obj, callback) => {
        // console.dir(obj, { depth: null, colors: true });
        callback = typeof obj === 'function' ? obj : callback;
        callback = typeof callback === 'function' ? callback : () => {};
        token = obj.token ? obj.token : null;
        bucket = obj.bucket ? obj.bucket : null;
        prefix = obj.prefix ? obj.prefix : null;

        const params = {
            Bucket: bucket,
            ContinuationToken: token,
            Prefix: prefix,
        };

        govS3.listObjectsV2(params, callback);
    };

    doWhilst(
        (next) => {
            list({ token, bucket, prefix }, (err, result) => {
                if (err) return next(err);
                if (result.IsTruncated) token = result.NextContinuationToken;
                isTruncated = result.IsTruncated;
                each(
                    result.Contents,
                    (row, cont) => {
                        row.Bucket = bucket;
                        row.Base = basename(row.Key);
                        keys.push(row);
                        cont();
                    },
                    (eachErr) => {
                        if (eachErr) return next(eachErr);
                        next();
                    }
                );
            });
        },
        (cb) => cb(null, isTruncated),
        (err, result) => {
            if (err) return cb(err);
            keys = keys.sort(sortByProperty('Key'));
            cb(null, keys);
        }
    );
};

const filesInPrefixOnCommercialPromise = (bucket, prefix) =>
    new Promise((res, rej) => {
        filesInPrefixOnCommercial(bucket, prefix, (err, data) => {
            if (err) return rej(err);
            res(data);
        });
    });

const filesInPrefixOnGovPromise = (bucket, prefix) =>
    new Promise((res, rej) => {
        filesInPrefixOnGov(bucket, prefix, (err, data) => {
            if (err) return rej(err);
            res(data);
        });
    });

const parseArgsIntoOptions = (rawArgs) => {
    const args = arg(
        {
            '--help': Boolean,
            '--prefix': String,
            '--GovBucket': String,
            '--CommercialBucket': String,

            '-h': '--help',
            '-p': '--prefix',
            '-g': '--GovBucket',
            '-c': '--CommercialBucket',
        },
        {
            argv: rawArgs.slice(2),
        }
    );
    return {
        help: args['--help'] || false,
        prefix: args['--prefix'] || null,
    };
};

const printHelp = () => {
    console.log(`This program is designed to
Available Arguments:
    --help              -h  show arguments that can be used with this executable
    --prefix            -p  provide the prefix wanting to be copied from commercial to gov cloud
    --GovBucket         -g  Bucket to copy prefix to in Gov Cloud
    --CommercialBucket  -c  Bucket to copy prefix from in Commercial`);
    process.exit(0);
};

const promptForMissingOptions = async (options) => {
    const questions = [];

    if (!options.prefix) {
        questions.push({
            type: 'input',
            name: 'prefix',
            message: 'What is the prefix to be copied from Commercial to Gov Cloud?',
        });
    }

    if (!options.GovBucket) {
        questions.push({
            type: 'input',
            name: 'GovBucket',
            message: 'What bucket in GovCloud to you want to copy prefix to?',
        });
    }

    if (!options.CommercialBucket) {
        questions.push({
            type: 'input',
            name: 'CommercialBucket',
            message: 'What bucket in Commercial AWS to you want to copy prefix from?',
        });
    }

    const answers = await inquirer.prompt(questions);

    return {
        ...options,
        prefix: options.prefix || answers.prefix,
        GovBucket: options.GovBucket || answers.GovBucket,
        CommercialBucket: options.CommercialBucket || answers.CommercialBucket,
    };
};

const openDBConn = () =>
    new Promise((res, rej) => {
        let dbConn = new sqlite3.Database(join(__dirname, 'issues.db'), sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
            if (err) return rej(err);
            dbConn.exec(`CREATE TABLE IF NOT EXISTS copyIssues (bucket VARCHAR(50), key VARCHAR(500), error MEDIUMTEXT)`, (err) => {
                if (err) return rej(err);
                res(dbConn);
            });
        });
    });

const copyKeysFromCommToGov = (commBucket, govBucket, keys, dbConn) =>
    new Promise((res, rej) => {
        each(
            keys,
            (key, next) => {
                // console.dir(key, { depth: null, colors: true });
                auto(
                    {
                        createDownloadDir: (cb) => {
                            let tempFolder = join(tmpdir(), uuidv4().replace(/-/g, ''));
                            console.log(`creating ${tempFolder}`);
                            fs.mkdir(tempFolder, (err) => {
                                if (err) return cb(err);
                                cb(null, tempFolder);
                            });
                        },
                        downloadFileHere: [
                            'createDownloadDir',
                            (results, cb) => {
                                downloadQ.push({ s3Bucket: commBucket, s3Key: key.Key, downloadPath: join(results.createDownloadDir, key.Base) }, cb);
                            },
                        ],
                        uploadFileToGov: [
                            'createDownloadDir',
                            'downloadFileHere',
                            (results, cb) => {
                                uploadQ.push({ s3Bucket: govBucket, s3Key: key.Key, uploadPath: join(results.createDownloadDir, key.Base) }, cb);
                            },
                        ],
                        removeDownloadDir: [
                            'createDownloadDir',
                            'downloadFileHere',
                            'uploadFileToGov',
                            (results, cb) => {
                                console.log(`removing ${results.createDownloadDir}`);
                                fs.remove(results.createDownloadDir, cb);
                            },
                        ],
                    },
                    (err, results) => {
                        if (err) {
                            console.error(err);
                            dbConn.run(
                                `INSERT INTO copyIssues (bucket, key, error) VALUES (?, ?, ?)`,
                                [key.Bucket, key.Key, JSON.stringify(err, null, 2)],
                                (dbErr) => {
                                    if (dbErr) console.error(dbErr);
                                    if (dbErr) return next(err);
                                }
                            );
                        }
                        next();
                    }
                );
            },
            (err) => {
                if (err) return rej(err);
                res();
            }
        );
    });

const main = async () => {
    let options = parseArgsIntoOptions(process.argv);
    if (options.help) printHelp();
    try {
        options = await promptForMissingOptions(options);
        if (!options.prefix) throw new Error('No Prefix Provided in Arguments or at Prompt');
        let dbconn = await openDBConn();

        let ckeys = await filesInPrefixOnCommercialPromise(options.CommercialBucket, options.prefix);
        console.log(ckeys.length);
        console.log(
            ckeys.reduce((acc, cur) => acc + parseInt(cur.Size, 10), 0),
            'Bytes'
        );

        // let gkeys = await filesInPrefixOnGovPromise(options.CommercialBucket, options.prefix);
        // console.log(gkeys.length);
        // console.log(
        //     gkeys.reduce((acc, cur) => acc + parseInt(cur.Size, 10), 0),
        //     'Bytes'
        // );

        await copyKeysFromCommToGov(options.CommercialBucket, options.GovBucket, ckeys, dbconn);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
};

main();

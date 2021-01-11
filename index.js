/**
 * ! Need two extra files in this directory: commercialCreds.json and govCreds.json for this script to work.
 * ! Along the lines of the following info in it.
{
    "accessKeyId": "ACCESSKEY",
    "secretAccessKey": "SECRTEKEYsecretkeySECRETKEY"
}
 */

const EventEmitter = require('events');
class UploadEmitter extends EventEmitter {}
const { tmpdir, EOL } = require('os');
const { basename, join } = require('path');
const { spawn } = require('child_process');
const arg = require('arg');
const { auto, queue, doWhilst, each, eachSeries } = require('async');
const { v4: uuidv4 } = require('uuid');
const aws = require('aws-sdk');
const { createWriteStream, mkdir, remove } = require('fs-extra');
const inquirer = require('inquirer');
const sqlite3 = require('sqlite3').verbose();

const commCreds = new aws.Credentials(require('./commercialCreds.json'));

const commS3 = new aws.S3({ apiVersion: '2006-03-01', region: 'us-east-1', signatureVersion: 'v4', credentials: commCreds });

const queueDepth = 10;

const MoveProgress = class {
    constructor(prefix) {
        this.prefix = prefix;
        this.stream = createWriteStream(`${prefix.replace(/\/|\\/g, '-')}-progress.txt`);
        this.stream.write(`date|time|PercentInt|PercentString|AdditionalInfo${EOL}`);
    }

    writeLine(percent, addInfo) {
        let now = new Date();
        let dateFormatter = new Intl.DateTimeFormat('en-us', {
            year: 'numeric',
            month: 'numeric',
            day: 'numeric'
        });
        let timeFormatter = new Intl.DateTimeFormat('en-us', {
            hour: 'numeric',
            minute: 'numeric',
            second: 'numeric',
            fractionalSecondDigits: 3,
            hour12: false,
            timeZone: 'UTC'
        });
        let date = dateFormatter.format(now);
        let time = timeFormatter.format(now);
        this.stream.write(`${date}|${time}|${percent}|${percent}% Complete${addInfo ? `|${addInfo}` : ''}${EOL}`);
    }

    end() {
        this.stream.end();
    }
};

let upload = false;
const uploadEmitter = new UploadEmitter();

// const uploadEmitter = new UploadEmitter();
const startUpload = () => {
    upload = spawn('node', [join(__dirname, 'upload.js')], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        windowsHide: true
    });
    upload.stdout.on('data', data => console.log('[upload]', data.toString()));
    upload.stderr.on('data', data => console.error('[upload]', data.toString()));

    upload.on('message', msg => {
        uploadEmitter.emit(msg.uuid, msg.callback);
        // uploadQ.resume();
    });

    upload.on('close', (code, signal) => {
        if (signal === 'SIGINT') {
            console.log(`Upload process killed.  Finished Successfully`);
        } else if (code) {
            console.error(`Upload process closed with exit code ${code}`);
            return process.exit(code);
        } else {
            console.error(`Upload process closed unexpectedly code: ${code}, signal ${signal}`);
        }
    });
};

const killUpload = () => {
    if (upload) {
        upload.kill('SIGINT');
        upload = false;
    }
};

const downloadQ = queue((task, cb) => {
    let e = false;
    const handleStreamError = err => {
        e = true;
        return cb(err);
    };

    const params = {
        Bucket: task.s3Bucket,
        Key: task.s3Key
    };
    console.log(`Downloading Bucket: '${task.s3Bucket}', Key: '${task.s3Key}' to ${task.downloadPath}`);

    const fileStream = createWriteStream(task.downloadPath);
    const s3Stream = commS3.getObject(params).createReadStream();

    fileStream.on('error', err => handleStreamError(err));
    s3Stream.on('error', err => handleStreamError(err));

    s3Stream.pipe(fileStream).on('close', data => {
        if (!e) cb(null, data);
    });
}, 2);

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
            Prefix: prefix
        };

        commS3.listObjectsV2(params, callback);
    };

    doWhilst(
        next => {
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
                    eachErr => {
                        if (eachErr) return next(eachErr);
                        next();
                    }
                );
            });
        },
        cb => cb(null, isTruncated),
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

const parseArgsIntoOptions = rawArgs => {
    const args = arg(
        {
            '--help': Boolean,
            '--prefix': String,
            '--GovBucket': String,
            '--CommercialBucket': String,

            '-h': '--help',
            '-p': '--prefix',
            '-g': '--GovBucket',
            '-c': '--CommercialBucket'
        },
        {
            argv: rawArgs.slice(2)
        }
    );
    return {
        help: args['--help'] || false,
        prefix: args['--prefix'] || null,
        CommercialBucket: args['--CommercialBucket'] || null,
        GovBucket: args['--GovBucket'] || null
    };
};

const printHelp = () => {
    console.log(`This program is designed to move objects in a Commercial S3 Bucket with specific prefix to a govcloud bucket with that same prefix
Available Arguments:
    --help              -h  show arguments that can be used with this executable
    --prefix            -p  provide the prefix wanting to be copied from commercial to gov cloud
    --CommercialBucket  -c  Bucket to copy prefix from in Commercial
    --GovBucket         -g  Bucket to copy prefix to in Gov Cloud`);
    process.exit(0);
};

const promptForMissingOptions = async options => {
    const questions = [];

    if (!options.prefix) {
        questions.push({
            type: 'input',
            name: 'prefix',
            message: 'What is the prefix to be copied from Commercial to Gov Cloud?'
        });
    }

    if (!options.CommercialBucket) {
        questions.push({
            type: 'input',
            name: 'CommercialBucket',
            message: 'What bucket in Commercial AWS to you want to copy prefix from?'
        });
    }

    if (!options.GovBucket) {
        questions.push({
            type: 'input',
            name: 'GovBucket',
            message: 'What bucket in GovCloud to you want to copy prefix to?'
        });
    }

    const answers = await inquirer.prompt(questions);

    return {
        ...options,
        prefix: options.prefix || answers.prefix,
        GovBucket: options.GovBucket || answers.GovBucket,
        CommercialBucket: options.CommercialBucket || answers.CommercialBucket
    };
};

const openDBConn = prefix =>
    new Promise((res, rej) => {
        let dbConn = new sqlite3.Database(join(__dirname, `${prefix.replace(/\/|\\/g, '-')}-issues.db`), sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, err => {
            if (err) return rej(err);
            dbConn.exec(`CREATE TABLE IF NOT EXISTS copyIssues (bucket VARCHAR(50), key VARCHAR(500), error MEDIUMTEXT)`, err => {
                if (err) return rej(err);
                res(dbConn);
            });
        });
    });

const copyQ = queue((task, callback) => {
    let uuid = uuidv4().replace(/-/g, '');
    auto(
        {
            createDownloadDir: cb => {
                let tempFolder = join(tmpdir(), uuid);
                console.log(`creating ${tempFolder}`);
                mkdir(tempFolder, err => {
                    if (err) return cb(err);
                    cb(null, tempFolder);
                });
            },
            downloadFileHere: [
                'createDownloadDir',
                (results, cb) => {
                    downloadQ.push({ s3Bucket: task.commBucket, s3Key: task.key.Key, downloadPath: join(results.createDownloadDir, task.key.Base) }, cb);
                }
            ],
            uploadFileToGov: [
                'createDownloadDir',
                'downloadFileHere',
                (results, cb) => {
                    uploadEmitter.once(uuid, cb);
                    if (upload.send) {
                        upload.send({
                            uuid: uuid,
                            Bucket: task.govBucket,
                            Key: task.key.Key,
                            uploadPath: join(results.createDownloadDir, task.key.Base),
                            cb: cb
                        });
                    } else {
                        return cb(new Error('Child Process Missing'));
                    }
                }
            ],
            removeDownloadDir: [
                'createDownloadDir',
                'downloadFileHere',
                'uploadFileToGov',
                (results, cb) => {
                    console.log(`removing ${results.createDownloadDir}`);
                    remove(results.createDownloadDir, cb);
                }
            ]
        },
        (err, results) => {
            if (err) {
                console.error(err);
                task.dbConn.run(
                    `INSERT INTO copyIssues (bucket, key, error) VALUES (?, ?, ?)`,
                    [task.key.Bucket, task.key.Key, JSON.stringify(err, null, 2)],
                    dbErr => {
                        if (dbErr) console.error(dbErr);
                        if (dbErr) return callback(err);
                    }
                );
            }
            callback();
        }
    );
}, queueDepth);

const copyKeysFromCommToGov = (commBucket, govBucket, keys, dbConn, progressFile) =>
    new Promise((res, rej) => {
        let totalBytes = keys.reduce((acc, cur) => acc + parseInt(cur.Size, 10), 0);
        let copied = 0;
        each(
            keys,
            (key, next) => {
                copyQ.push({ commBucket, govBucket, key, dbConn }, err => {
                    if (err) return next(err);
                    let previousPercent = totalBytes ? Math.floor((copied / totalBytes) * 100) : 0;
                    copied += key.Size;
                    let percent = totalBytes ? Math.floor((copied / totalBytes) * 100) : 0;
                    console.log(`${percent}% completed`);
                    if (percent > previousPercent) progressFile.writeLine(percent);
                    next();
                });
            },
            err => {
                progressFile.end();
                if (err) return rej(err);
                res();
            }
        );
    });

const durationInDHMS = ms => {
    const pad = n => (n < 10 ? '0' + n : n);
    const msAfterDays = ms % (24 * 60 * 60 * 1000);
    const msAfterHours = ms % (60 * 60 * 1000);
    const msAfterMinutes = ms % (60 * 1000);
    const msAfterSeconds = ms % 1000;

    const days = Math.floor(ms / (24 * 60 * 60 * 1000));
    const hours = Math.floor(msAfterDays / (60 * 60 * 1000));
    const minutes = Math.floor(msAfterHours / (60 * 1000));
    const seconds = Math.floor(msAfterMinutes / 1000);
    return `${pad(days)} days, ${pad(hours)} hours, ${pad(minutes)} minutes, ${pad(seconds)}.${msAfterSeconds} seconds`;
};

const main = async () => {
    let start = new Date().getTime();
    startUpload();
    let options = parseArgsIntoOptions(process.argv);
    if (options.help) printHelp();
    try {
        options = await promptForMissingOptions(options);
        if (!options.prefix) throw new Error('No Prefix Provided in Arguments or at Prompt');

        let dbconn = await openDBConn(options.prefix);

        const moveProgress = new MoveProgress(options.prefix);
        moveProgress.writeLine(0, 'Done Requesting Parameters');

        let ckeys = await filesInPrefixOnCommercialPromise(options.CommercialBucket, options.prefix);
        const bytes = ckeys.reduce((acc, cur) => acc + parseInt(cur.Size, 10), 0);
        console.log(ckeys.length);
        console.log(bytes, 'Bytes');

        moveProgress.writeLine(
            0,
            `Found all Objects in Commercial Bucket '${options.CommercialBucket}', Prefix: '${options.prefix}': ${ckeys.length} ${
                ckeys.length === 1 ? `Object` : `Objects`
            }, ${bytes} ${bytes === 1 ? `Bytes` : `Byte`}`
        );
        await copyKeysFromCommToGov(options.CommercialBucket, options.GovBucket, ckeys, dbconn, moveProgress);
        let finish = new Date().getTime();
        console.log(`took ${durationInDHMS(finish - start)}`);
        dbconn.close();
        killUpload();
    } catch (e) {
        console.error(e);
        dbconn.close();
        killUpload();
        process.exit(1);
    }
};

main();

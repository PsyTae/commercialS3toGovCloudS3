const { queue } = require('async');
const aws = require('aws-sdk');
const govCreds = new aws.Credentials(require('./govCreds.json'));
const govEndPoint = new aws.Endpoint('s3-fips.us-gov-east-1.amazonaws.com');
const govS3 = new aws.S3({ apiVersion: '2006-03-01', region: 'us-gov-east-1', endpoint: govEndPoint, signatureVersion: 'v4', credentials: govCreds });

const queueDepth = 10;

const s3Upload = require('s3-upload-resume');

const s3UploadClient = s3Upload.createClient({
    multipartUploadThreshold: 5 * 1024 * 1024,
    multipartUploadSize: 5 * 1024 * 1024,
    s3Client: govS3
});

const uploadQ = queue((task, cb) => {
    const params = {
        localFile: task.uploadPath,

        s3Params: {
            Bucket: task.s3Bucket,
            Key: task.s3Key
        }
    };

    const upload = s3UploadClient.uploadFile(params);

    upload.on('uploading', data => {
        switch (data) {
            case 'putting':
                console.log(`Putting ${upload.localFile} to Bucket: '${upload.s3Bucket}', Key: '${upload.s3Key}'`);
                break;
            case 'starting':
                console.log(`Starting new mulitpart upload of ${upload.localFile} to Bucket: '${upload.s3Bucket}', Key: '${upload.s3Key}'`);
                break;
            case 'resuming':
                console.log(`Resuming a multipart upload of ${upload.localFile} to Bucket: '${upload.s3Bucket}', Key: '${upload.s3Key}'`);
                break;
            default:
                break;
        }
    });

    upload.on('error', err => {
        if (process.send) {
            process.send({
                uuid: task.uuid,
                callback: cb(err)
            });
        }
    });

    upload.on('end', data => {
        if (process.send) {
            process.send({
                uuid: task.uuid,
                callback: cb(null, data)
            });
        }
    });
}, queueDepth);

process.on('message', msg => {
    uploadQ.push({ uuid: msg.uuid, s3Bucket: msg.Bucket, s3Key: msg.Key, uploadPath: msg.uploadPath }, msg.cb);
});

process.once('uncaughtException', err => {
    console.error(`Uncaught Exception Error:`, '\n', err);
    process.exit(1);
});

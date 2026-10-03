import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export class ObjectStorageConfigurationError extends Error {
  constructor() {
    super("Private object storage is not configured");
    this.name = "ObjectStorageConfigurationError";
  }
}

interface R2Configuration {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

function getConfiguration(environment: RuntimeEnvironment = process.env): R2Configuration {
  const accountId = environment.R2_ACCOUNT_ID?.trim();
  const accessKeyId = environment.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = environment.R2_SECRET_ACCESS_KEY;
  const bucket = environment.R2_BUCKET?.trim();
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    throw new ObjectStorageConfigurationError();
  }
  return { accountId, accessKeyId, secretAccessKey, bucket };
}

let cachedClient: S3Client | undefined;
let cachedBucket: string | undefined;

function getClient() {
  const configuration = getConfiguration();
  if (!cachedClient || cachedBucket !== configuration.bucket) {
    cachedClient?.destroy();
    cachedClient = new S3Client({
      region: "auto",
      endpoint: `https://${configuration.accountId}.r2.cloudflarestorage.com`,
      forcePathStyle: true,
      credentials: {
        accessKeyId: configuration.accessKeyId,
        secretAccessKey: configuration.secretAccessKey,
      },
    });
    cachedBucket = configuration.bucket;
  }
  return { client: cachedClient, bucket: configuration.bucket };
}

export function isPrivateObjectStorageConfigured(environment: RuntimeEnvironment = process.env) {
  return Boolean(
    environment.R2_ACCOUNT_ID?.trim() &&
      environment.R2_ACCESS_KEY_ID?.trim() &&
      environment.R2_SECRET_ACCESS_KEY &&
      environment.R2_BUCKET?.trim(),
  );
}

export async function createPresignedUploadUrl(input: {
  key: string;
  contentType: string;
  size: number;
}): Promise<string> {
  const { client, bucket } = getClient();
  return getSignedUrl(
    client,
    new PutObjectCommand({
      Bucket: bucket,
      Key: input.key,
      ContentType: input.contentType,
      ContentLength: input.size,
    }),
    { expiresIn: 300 },
  );
}

export async function createPresignedDownloadUrl(key: string): Promise<string> {
  const { client, bucket } = getClient();
  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: 300 },
  );
}

export async function readPrivateObject(input: {
  key: string;
  expectedSize: number;
}): Promise<{ bytes: Buffer; contentType: string | null }> {
  const { client, bucket } = getClient();
  const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: input.key }));
  if (head.ContentLength !== input.expectedSize) {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: input.key }));
    throw new Error("Stored object size does not match the upload reservation");
  }
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: input.key }));
  if (!result.Body) throw new Error("Stored object has no content");
  const bytes = Buffer.from(await result.Body.transformToByteArray());
  if (bytes.length !== input.expectedSize) {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: input.key }));
    throw new Error("Stored object changed during verification");
  }
  return { bytes, contentType: head.ContentType ?? null };
}

export async function deletePrivateObject(key: string): Promise<void> {
  const { client, bucket } = getClient();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

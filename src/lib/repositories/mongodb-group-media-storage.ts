import { Readable } from "node:stream";
import { GridFSBucket, ObjectId } from "mongodb";
import type { Db } from "mongodb";
import type { ValidatedGroupMedia } from "@/lib/ingestion/media-validation";

const BUCKET_NAME = "group_media";
const STORAGE_PREFIX = `mongodb-gridfs://${BUCKET_NAME}/`;

export function isManagedGroupMediaStorageUri(storageUri: string): boolean {
  return storageUri.startsWith(STORAGE_PREFIX) &&
    ObjectId.isValid(storageUri.slice(STORAGE_PREFIX.length));
}

export class MongoGroupMediaStorage {
  private readonly bucket: GridFSBucket;

  constructor(private readonly database: Db) {
    this.bucket = new GridFSBucket(database, { bucketName: BUCKET_NAME });
  }

  async save(
    bytes: Uint8Array,
    metadata: {
      groupId: string;
      fragmentId: string;
      authorUserId: string;
      media: ValidatedGroupMedia;
    },
  ): Promise<string> {
    const id = new ObjectId();
    const stream = this.bucket.openUploadStreamWithId(
      id,
      `${metadata.fragmentId}.${metadata.media.extension}`,
      {
        metadata: {
          groupId: metadata.groupId,
          fragmentId: metadata.fragmentId,
          authorUserId: metadata.authorUserId,
          contentType: metadata.media.mimeType,
          fileSizeBytes: metadata.media.fileSizeBytes,
        },
      },
    );
    await new Promise<void>((resolve, reject) => {
      stream.once("error", reject);
      stream.once("finish", resolve);
      Readable.from([bytes]).pipe(stream);
    });
    return `${STORAGE_PREFIX}${id.toHexString()}`;
  }

  async load(input: {
    storageUri: string;
    groupId: string;
    fragmentId: string;
    authorUserId: string;
    maximumBytes: number;
  }): Promise<{ bytes: Buffer; mimeType: string } | null> {
    const id = this.parseStorageId(input.storageUri);
    if (!id) return null;
    const file = await this.database.collection(`${BUCKET_NAME}.files`).findOne({
      _id: id,
      "metadata.groupId": input.groupId,
      "metadata.fragmentId": input.fragmentId,
      "metadata.authorUserId": input.authorUserId,
    });
    if (
      !file ||
      typeof file.length !== "number" ||
      file.length < 1 ||
      file.length > input.maximumBytes ||
      typeof file.metadata?.contentType !== "string"
    ) return null;
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of this.bucket.openDownloadStream(id)) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += value.length;
      if (total > input.maximumBytes) {
        throw new Error("Stored group media exceeds its validated size limit");
      }
      chunks.push(value);
    }
    return { bytes: Buffer.concat(chunks, total), mimeType: file.metadata.contentType };
  }

  async delete(storageUri: string, input: { groupId: string; fragmentId: string }): Promise<void> {
    const id = this.parseStorageId(storageUri);
    if (!id) throw new Error("Group media storage reference is invalid");
    const file = await this.database.collection(`${BUCKET_NAME}.files`).findOne({
      _id: id,
      "metadata.groupId": input.groupId,
      "metadata.fragmentId": input.fragmentId,
    });
    if (!file) return;
    try {
      await this.bucket.delete(id);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) return;
      throw error;
    }
  }

  private parseStorageId(storageUri: string): ObjectId | null {
    if (!isManagedGroupMediaStorageUri(storageUri)) return null;
    return new ObjectId(storageUri.slice(STORAGE_PREFIX.length));
  }
}

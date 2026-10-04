import { Readable } from "node:stream";
import { GridFSBucket, ObjectId } from "mongodb";
import type { Db } from "mongodb";

const BUCKET_NAME = "voice_notes";
const STORAGE_PREFIX = `mongodb-gridfs://${BUCKET_NAME}/`;

export interface VoiceObjectMetadata {
  groupId: string;
  fragmentId: string;
  authorUserId: string;
}

export class MongoVoiceStorage {
  private readonly bucket: GridFSBucket;

  constructor(private readonly database: Db) {
    this.bucket = new GridFSBucket(database, { bucketName: BUCKET_NAME });
  }

  async save(bytes: Uint8Array, metadata: VoiceObjectMetadata): Promise<string> {
    const id = new ObjectId();
    const stream = this.bucket.openUploadStreamWithId(id, "voice-note.wav", {
      metadata: { ...metadata, contentType: "audio/wav" },
    });
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
    authorUserId?: string;
    maximumBytes: number;
  }): Promise<Buffer | null> {
    const id = this.parseStorageId(input.storageUri);
    if (!id) return null;
    const file = await this.database.collection(`${BUCKET_NAME}.files`).findOne({
      _id: id,
      "metadata.groupId": input.groupId,
      "metadata.fragmentId": input.fragmentId,
      ...(input.authorUserId ? { "metadata.authorUserId": input.authorUserId } : {}),
    });
    if (!file || typeof file.length !== "number" || file.length > input.maximumBytes) return null;
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of this.bucket.openDownloadStream(id)) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += value.length;
      if (total > input.maximumBytes) throw new Error("Stored voice note exceeds its validated size limit");
      chunks.push(value);
    }
    return Buffer.concat(chunks, total);
  }

  async delete(storageUri: string): Promise<void> {
    const id = this.parseStorageId(storageUri);
    if (!id) throw new Error("Voice note storage reference is invalid");
    const file = await this.database.collection(`${BUCKET_NAME}.files`).findOne({ _id: id });
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
    if (!storageUri.startsWith(STORAGE_PREFIX)) return null;
    const value = storageUri.slice(STORAGE_PREFIX.length);
    return ObjectId.isValid(value) ? new ObjectId(value) : null;
  }
}

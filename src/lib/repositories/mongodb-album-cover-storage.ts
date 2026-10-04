import { Readable } from "node:stream";
import { GridFSBucket, ObjectId } from "mongodb";
import type { Db } from "mongodb";
import type { ValidatedGroupMedia } from "@/lib/ingestion/media-validation";

const BUCKET_NAME = "album_covers";

export interface AlbumCoverReference {
  storageId: string;
  mimeType: ValidatedGroupMedia["mimeType"];
  fileSizeBytes: number;
}

export class MongoAlbumCoverStorage {
  private readonly bucket: GridFSBucket;

  constructor(private readonly database: Db) {
    this.bucket = new GridFSBucket(database, { bucketName: BUCKET_NAME });
  }

  async save(
    bytes: Uint8Array,
    input: { groupId: string; media: ValidatedGroupMedia },
  ): Promise<AlbumCoverReference> {
    const id = new ObjectId();
    const stream = this.bucket.openUploadStreamWithId(id, `album-cover.${input.media.extension}`, {
      metadata: {
        groupId: input.groupId,
        contentType: input.media.mimeType,
        fileSizeBytes: input.media.fileSizeBytes,
      },
    });
    await new Promise<void>((resolve, reject) => {
      stream.once("error", reject);
      stream.once("finish", resolve);
      Readable.from([bytes]).pipe(stream);
    });
    return {
      storageId: id.toHexString(),
      mimeType: input.media.mimeType,
      fileSizeBytes: input.media.fileSizeBytes,
    };
  }

  async load(input: {
    storageId: string;
    groupId: string;
    maximumBytes: number;
  }): Promise<{ bytes: Buffer; mimeType: string } | null> {
    if (!ObjectId.isValid(input.storageId)) return null;
    const id = new ObjectId(input.storageId);
    const file = await this.database.collection(`${BUCKET_NAME}.files`).findOne({
      _id: id,
      "metadata.groupId": input.groupId,
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
      if (total > input.maximumBytes) throw new Error("Stored album cover exceeds its validated size limit");
      chunks.push(value);
    }
    return { bytes: Buffer.concat(chunks, total), mimeType: file.metadata.contentType };
  }

  async delete(storageId: string, groupId: string): Promise<void> {
    if (!ObjectId.isValid(storageId)) throw new Error("Album cover storage reference is invalid");
    const id = new ObjectId(storageId);
    const file = await this.database.collection(`${BUCKET_NAME}.files`).findOne({
      _id: id,
      "metadata.groupId": groupId,
    });
    if (!file) return;
    await this.bucket.delete(id);
  }
}

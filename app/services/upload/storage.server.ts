import { S3Client } from "@aws-sdk/client-s3";
import { AwsS3StorageAdapter } from "@flystorage/aws-s3";
import { FileStorage } from "@flystorage/file-storage";
import { LocalStorageAdapter } from "@flystorage/local-fs";
import type {
  DestinationConfig,
  LocalConfig,
  S3Config,
  UploadDestination,
} from "~/db/schema";

// Flystorage is confined to this file. The rest of the app only sees UploadTarget,
// so swapping the library (rclone, unstorage, etc) means changing only this file.
export interface UploadTarget {
  write(path: string, contents: string): Promise<void>;
}

/** Build the write target for a destination from its type + config. */
export function buildTarget(dest: UploadDestination): UploadTarget {
  const storage = buildStorage(dest.type, dest.config);
  return {
    write: (path, contents) => storage.write(path, contents),
  };
}

function buildStorage(
  type: UploadDestination["type"],
  config: DestinationConfig,
): FileStorage {
  switch (type) {
    case "s3": {
      const c = config as S3Config;
      const client = new S3Client({
        region: c.region,
        endpoint: c.endpoint || undefined,
        forcePathStyle: c.forcePathStyle ?? false,
        credentials: {
          accessKeyId: c.accessKeyId,
          secretAccessKey: c.secretAccessKey,
        },
      });
      return new FileStorage(
        new AwsS3StorageAdapter(client, { bucket: c.bucket, prefix: c.prefix }),
      );
    }
    case "local": {
      const c = config as LocalConfig;
      return new FileStorage(new LocalStorageAdapter(c.path));
    }
  }
}

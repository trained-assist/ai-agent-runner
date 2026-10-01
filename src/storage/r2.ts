import type { BlobCallOptions, BlobHead, BlobRef, BlobShareOptions, BlobShareUrl, BlobStore } from './blob-store.js';
import { StorageError } from './errors.js';

export interface R2BlobStoreOptions {
  endpoint?: string;
  bucket?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

const GAP =
  'r2/s3 backend is a scaffold in slice D1: it needs an S3 client (@aws-sdk/client-s3), presigned upload/download sessions ' +
  '(@aws-sdk/s3-request-presigner), multipart/resume with abort-expiry cleanup and bucket CORS for browser transfers';

export class R2BlobStore implements BlobStore {
  readonly backend = 'r2' as const;
  readonly options: R2BlobStoreOptions;

  constructor(options: R2BlobStoreOptions = {}) {
    this.options = options;
  }

  put(_key: string, _bytes: Uint8Array | string, _options?: BlobCallOptions): Promise<BlobRef> {
    return Promise.reject(this.unsupported('put'));
  }

  get(_key: string, _options?: BlobCallOptions): Promise<Buffer> {
    return Promise.reject(this.unsupported('get'));
  }

  head(_key: string, _options?: BlobCallOptions): Promise<BlobHead> {
    return Promise.reject(this.unsupported('head'));
  }

  delete(_key: string, _options?: BlobCallOptions): Promise<void> {
    return Promise.reject(this.unsupported('delete'));
  }

  shareUrl(_key: string, _options?: BlobShareOptions): Promise<BlobShareUrl> {
    return Promise.reject(this.unsupported('shareUrl'));
  }

  private unsupported(operation: string): StorageError {
    return new StorageError('BLOB_BACKEND_UNSUPPORTED', `r2 backend does not support ${operation} yet: ${GAP}`);
  }
}

export function createR2BlobStore(options: R2BlobStoreOptions = {}): R2BlobStore {
  return new R2BlobStore(options);
}

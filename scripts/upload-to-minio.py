#!/usr/bin/env -S uv run --script
# /// script
# dependencies = ["minio"]
# ///

"""
upload-to-minio.py
Uploads documents or OpenAPI JSON specifications to g9 MinIO storage.

Usage:
  uv run scripts/upload-to-minio.py <file-path> [--bucket knowledge-docs] [--target-key incoming/toss-invest-openapi.json]
"""

import sys
import os
import argparse
from pathlib import Path
from minio import Minio

def main():
    parser = argparse.ArgumentParser(description="Upload documents to g9 MinIO bucket")
    parser.add_argument("file_path", help="Local file path to upload")
    parser.add_argument("--endpoint", default=os.getenv("MINIO_ENDPOINT", "100.120.155.54:30900"), help="MinIO endpoint (default: 100.120.155.54:30900)")
    parser.add_argument("--access-key", default=os.getenv("MINIO_ACCESS_KEY", "minioadmin"), help="MinIO access key")
    parser.add_argument("--secret-key", default=os.getenv("MINIO_SECRET_KEY", ""), help="MinIO secret key")
    parser.add_argument("--bucket", default="knowledge-docs", help="Target bucket name (default: knowledge-docs)")
    parser.add_argument("--target-key", default=None, help="Target S3 object key (e.g. incoming/toss-invest-openapi.json)")
    parser.add_argument("--secure", action="store_true", default=False, help="Use HTTPS")

    args = parser.parse_args()

    local_path = Path(args.file_path)
    if not local_path.is_file():
        print(f"[Error] File not found: {local_path}", file=sys.stderr)
        sys.exit(1)

    target_key = args.target_key
    if not target_key:
        target_key = f"incoming/{local_path.name}"

    if not args.secret_key:
        print("[Error] MINIO_SECRET_KEY is required. Pass --secret-key or set MINIO_SECRET_KEY environment variable.", file=sys.stderr)
        sys.exit(1)

    client = Minio(
        args.endpoint,
        access_key=args.access_key,
        secret_key=args.secret_key,
        secure=args.secure
    )

    if not client.bucket_exists(args.bucket):
        print(f"[*] Creating bucket '{args.bucket}'...")
        client.make_bucket(args.bucket)

    print(f"[*] Uploading '{local_path}' ({local_path.stat().st_size} bytes) -> s3://{args.bucket}/{target_key}...")
    client.fput_object(args.bucket, target_key, str(local_path))
    print(f"[ok] Successfully uploaded to s3://{args.bucket}/{target_key}")

if __name__ == "__main__":
    main()

#!/usr/bin/env -S uv run --script
# /// script
# dependencies = ["minio"]
# ///

"""
sync-and-index-cron.py
Periodically checks MinIO 'knowledge-docs' bucket for new incoming files,
runs normalization and index synchronization to GCP Discovery Engine,
and archives processed files.
"""

import sys
import os
import subprocess
import json
from pathlib import Path
from minio import Minio
from minio.error import S3Error

def log(msg: str):
    print(f"[k3s-sync-runner] {msg}", flush=True)

def main():
    log("Starting knowledge-qna sync runner...")

    minio_endpoint = os.getenv("MINIO_ENDPOINT", "g9-minio.minio.svc.cluster.local:9000")
    minio_access_key = os.getenv("MINIO_ACCESS_KEY", "minioadmin")
    minio_secret_key = os.getenv("MINIO_SECRET_KEY", "")
    bucket_name = os.getenv("MINIO_BUCKET", "knowledge-docs")
    gcp_creds = os.getenv("GOOGLE_APPLICATION_CREDENTIALS", "/etc/gcp/credentials.json")
    repo_root = Path(os.getenv("KNOWLEDGE_QNA_ROOT", "/app"))

    if not minio_secret_key:
        log("MINIO_SECRET_KEY not set. Checking /etc/minio/secret...")
        sec_file = Path("/etc/minio/MINIO_ROOT_PASSWORD")
        if sec_file.is_file():
            minio_secret_key = sec_file.read_text().strip()

    client = Minio(
        minio_endpoint,
        access_key=minio_access_key,
        secret_key=minio_secret_key,
        secure=False
    )

    if not client.bucket_exists(bucket_name):
        log(f"Bucket '{bucket_name}' not found. Creating...")
        client.make_bucket(bucket_name)

    # 1. Scan incoming/ prefix
    objects = list(client.list_objects(bucket_name, prefix="incoming/", recursive=True))
    if not objects:
        log("No incoming files found in s3://knowledge-docs/incoming/. Exiting normally.")
        return

    log(f"Found {len(objects)} object(s) in s3://{bucket_name}/incoming/")

    cache_dir = repo_root / "var" / "incoming"
    cache_dir.mkdir(parents=True, exist_ok=True)

    for obj in objects:
        if obj.object_name.endswith("/"):
            continue

        file_name = Path(obj.object_name).name
        local_dest = cache_dir / file_name
        log(f"Downloading s3://{bucket_name}/{obj.object_name} -> {local_dest} ({obj.size} bytes)")
        client.fget_object(bucket_name, obj.object_name, str(local_dest))

        # Determine library mapping
        library_id = "toss-invest-openapi" if "toss" in file_name.lower() or "openapi" in file_name.lower() else None

        if library_id:
            log(f"Processing library '{library_id}' for file '{file_name}'...")
            
            env = dict(os.environ)
            env["GOOGLE_APPLICATION_CREDENTIALS"] = gcp_creds

            # Step 1: Run sync to produce local corpus revision and chunks
            log(f"Running sync for library '{library_id}'...")
            cmd_sync = ["node", "./bin/docsctx.js", "sync", library_id]
            res_sync = subprocess.run(cmd_sync, cwd=str(repo_root), env=env, capture_output=True, text=True)
            if res_sync.returncode != 0:
                log(f"[Error] Sync failed for '{library_id}' (exit {res_sync.returncode}):")
                print(res_sync.stderr, file=sys.stderr)
                sys.exit(res_sync.returncode)
            log(f"[ok] Sync succeeded for '{library_id}'.")

            # Step 2: Run index to publish to Google Cloud Discovery Engine
            log(f"Running index for library '{library_id}'...")
            cmd = ["node", "./bin/docsctx.js", "index", library_id]
            res = subprocess.run(cmd, cwd=str(repo_root), env=env, capture_output=True, text=True)

            if res.returncode == 0:
                log(f"[ok] Indexing succeeded for '{library_id}'.")
                print(res.stdout)

                # Move from incoming/ to synced/
                synced_key = f"synced/{file_name}"
                log(f"Archiving object to s3://{bucket_name}/{synced_key}...")
                client.copy_object(
                    bucket_name,
                    synced_key,
                    f"/{bucket_name}/{obj.object_name}"
                )
                client.remove_object(bucket_name, obj.object_name)
                log(f"[ok] Archived {obj.object_name} -> {synced_key}")
            else:
                log(f"[Error] Indexing failed for '{library_id}' (exit {res.returncode}):")
                print(res.stderr, file=sys.stderr)
                sys.exit(res.returncode)

    log("Sync runner finished successfully.")

if __name__ == "__main__":
    main()

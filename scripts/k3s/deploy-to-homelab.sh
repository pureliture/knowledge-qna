#!/usr/bin/env bash
set -euo pipefail

TARGET_HOST="g9-llmbrain-tunnel"
TARGET_DIR="/var/lib/knowledge-qna"
KUBECONFIG_PATH="$HOME/.kube/oci-k3s-poc-config"

echo "[*] Ensuring target directory on homelab..."
ssh "$TARGET_HOST" "sudo mkdir -p $TARGET_DIR && sudo chown -R pureliture:pureliture $TARGET_DIR"

echo "[*] Syncing knowledge-qna source code to homelab ($TARGET_DIR)..."
rsync -avz --delete \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude 'dist' \
  --exclude 'var' \
  --exclude '.worktrees' \
  ./ "$TARGET_HOST:$TARGET_DIR/"

echo "[*] Applying k3s CronJob manifest..."
KUBECONFIG="$KUBECONFIG_PATH" kubectl apply -f k8s/cronjob.yaml

echo "[ok] Deployment complete! Checking CronJob status:"
KUBECONFIG="$KUBECONFIG_PATH" kubectl get cronjobs -n knowledge-qna

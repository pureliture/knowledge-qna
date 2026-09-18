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

echo "[*] Applying k3s manifests..."
KUBECONFIG="$KUBECONFIG_PATH" kubectl apply -f k8s/cronjob.yaml
KUBECONFIG="$KUBECONFIG_PATH" kubectl apply -f k8s/mcp-server-deployment.yaml

echo "[*] Triggering rollout restart of MCP server to pick up new code..."
KUBECONFIG="$KUBECONFIG_PATH" kubectl rollout restart deployment/knowledge-qna-mcp-server -n knowledge-qna || true

echo "[*] Waiting for MCP server deployment rollout..."
KUBECONFIG="$KUBECONFIG_PATH" kubectl rollout status deployment/knowledge-qna-mcp-server -n knowledge-qna --timeout=60s || true

echo "[*] Ensuring Tailscale Serve HTTPS proxy on port 30443..."
ssh "$TARGET_HOST" "sudo tailscale serve --bg --https 30443 http://127.0.0.1:30080"

echo "[ok] Deployment complete! Checking resources in knowledge-qna:"
KUBECONFIG="$KUBECONFIG_PATH" kubectl get all -n knowledge-qna

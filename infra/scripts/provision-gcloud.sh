#!/usr/bin/env bash
set -euo pipefail

# Provision Discovery Engine using gcloud and Google REST API
# Usage: ./infra/scripts/provision-gcloud.sh <PROJECT_ID> [DATA_STORE_ID] [SEARCH_ENGINE_ID]

PROJECT_ID="${1:-${GOOGLE_AGENT_SEARCH_PROJECT_ID:-}}"
DATA_STORE_ID="${2:-knowledge-qna-ds}"
SEARCH_ENGINE_ID="${3:-knowledge-qna-engine}"
LOCATION="global"
COLLECTION_ID="default_collection"

if [[ -z "$PROJECT_ID" ]]; then
  echo "Error: PROJECT_ID is required as first argument or via GOOGLE_AGENT_SEARCH_PROJECT_ID."
  exit 1
fi

echo "==> Step 1: Enabling discoveryengine.googleapis.com on project ${PROJECT_ID}..."
gcloud services enable discoveryengine.googleapis.com --project="${PROJECT_ID}"

echo "==> Step 2: Checking access token..."
ACCESS_TOKEN=$(gcloud auth print-access-token)

echo "==> Step 3: Checking or Creating Data Store (${DATA_STORE_ID})..."
DS_URL="https://discoveryengine.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/collections/${COLLECTION_ID}/dataStores"

HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  "${DS_URL}/${DATA_STORE_ID}" || true)

if [[ "$HTTP_STATUS" == "200" ]]; then
  echo "Data Store '${DATA_STORE_ID}' already exists."
else
  echo "Creating Data Store '${DATA_STORE_ID}'..."
  curl -s -X POST \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" \
    -H "Content-Type: application/json" \
    -H "X-Goog-User-Project: ${PROJECT_ID}" \
    "${DS_URL}?dataStoreId=${DATA_STORE_ID}" \
    -d '{
      "displayName": "Knowledge QnA Data Store",
      "industryVertical": "GENERIC",
      "solutionTypes": ["SOLUTION_TYPE_SEARCH"],
      "contentConfig": "CONTENT_REQUIRED"
    }'
  echo ""
fi

echo "==> Step 4: Environment Variables for docsctx:"
echo "---------------------------------------------------------"
echo "export GOOGLE_AGENT_SEARCH_PROJECT_ID=\"${PROJECT_ID}\""
echo "export GOOGLE_AGENT_SEARCH_DATA_STORE_ID=\"${DATA_STORE_ID}\""
echo "export GOOGLE_AGENT_SEARCH_LOCATION=\"${LOCATION}\""
echo "export GOOGLE_AGENT_SEARCH_SERVING_CONFIG_ID=\"default_search\""
echo "---------------------------------------------------------"
echo "==> Provisioning complete."

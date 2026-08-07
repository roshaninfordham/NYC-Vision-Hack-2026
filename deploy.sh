#!/usr/bin/env bash
# CurbWatch — one-shot Cloud Run deploy. Run from repo root inside Cloud Shell.
set -euo pipefail

REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-curbwatch}"
PROJECT="$(gcloud config get-value project 2>/dev/null)"

echo "Deploying $SERVICE to project $PROJECT in $REGION..."

gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --memory 512Mi \
  --set-env-vars "ROBOFLOW_MODEL=coco/24,GOOGLE_CLOUD_PROJECT=$PROJECT" \
  ${ROBOFLOW_API_KEY:+--set-env-vars "ROBOFLOW_API_KEY=$ROBOFLOW_API_KEY"} \
  ${GEMINI_API_KEY:+--set-env-vars "GEMINI_API_KEY=$GEMINI_API_KEY"}

echo ""
echo "Deployed. Service URL:"
gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)'

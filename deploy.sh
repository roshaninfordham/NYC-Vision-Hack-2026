#!/usr/bin/env bash
# CurbWatch — one-shot Cloud Run deploy. Run from repo root inside Cloud Shell.
set -euo pipefail

REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-curbwatch}"
PROJECT="$(gcloud config get-value project 2>/dev/null)"

# Fresh projects: Cloud Build runs as the compute default SA, which lacks
# permission to read uploaded sources until granted the builds.builder role.
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
echo "Ensuring Cloud Build permissions for ${PROJECT_NUMBER}-compute@developer.gserviceaccount.com..."
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/cloudbuild.builds.builder" \
  --condition=None --quiet >/dev/null || echo "  (grant failed — continuing; deploy may still work)"

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

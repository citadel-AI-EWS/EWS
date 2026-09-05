#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
REGION="${1:-${AWS_REGION:-eu-central-1}}"
STACK_NAME="ews-controller-test-v0-3"
ORIGIN="${2:-https://citadel-ai.init1.workers.dev}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="ews-controller-test-deploy-${ACCOUNT_ID}-${REGION}"
echo "AWS account: $ACCOUNT_ID"
echo "Region: $REGION"
echo "Origin: $ORIGIN"
if ! aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  if [ "$REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$BUCKET" >/dev/null
  else
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" --create-bucket-configuration LocationConstraint="$REGION" >/dev/null
  fi
fi
"$SCRIPT_DIR/scripts/package_controller.sh" "$SCRIPT_DIR/controller_lambda.zip"
trap 'rm -f "$SCRIPT_DIR/controller_lambda.zip" "$SCRIPT_DIR/packaged.yaml"' EXIT
aws cloudformation package --region "$REGION" --template-file controller_template.yaml --s3-bucket "$BUCKET" --output-template-file packaged.yaml
aws cloudformation deploy --region "$REGION" --template-file packaged.yaml --stack-name "$STACK_NAME" --capabilities CAPABILITY_IAM --parameter-overrides AllowedOrigin="$ORIGIN" --no-fail-on-empty-changeset
aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK_NAME" --query 'Stacks[0].Outputs' --output table

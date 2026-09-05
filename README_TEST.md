# TEST — EWS Controller v0.3

**Not for clients. Not a production release.**

This package is the first EWS test build where the web UI can submit an Apply request to the Controller and the Controller can create a real AWS per-project CloudFormation stack.

## What happens on TEST Apply

1. The website sends `POST /projects/apply` to the Controller API.
2. The Controller requires the temporary TEST session token and must be in `ENABLED` state.
3. It validates that a project description exists.
4. It creates a project record in DynamoDB.
5. It calls the AWS CloudFormation API.
6. CloudFormation assumes a dedicated project-stack execution role.
7. The project stack launches **one `t3.micro` EC2 TEST worker** in an isolated EWS test subnet.
8. The worker receives **no public IP**, there is **no Internet Gateway/NAT**, and the security group has **no inbound rules**. Network default is therefore effectively OFF for this first worker.
9. The website can later query the project status through the Controller.
10. Every TEST project expires after six hours by default (configurable per request from 1–24 hours),
    and the scheduled cleanup retries CloudFormation deletion every 15 minutes.

## Important architecture rule

The Controller itself does **not** receive long-lived AWS access keys and the website never receives AWS credentials.

The Controller runs inside AWS Lambda. AWS gives the Lambda temporary credentials for its IAM execution role automatically. The Controller uses `boto3` to call AWS APIs with those temporary role credentials.

For project provisioning, the Controller does not directly receive unrestricted EC2 rights. It asks CloudFormation to create an `ews-project-*` stack and may pass only the dedicated `ProjectStackExecutionRole`.

## Why no AWS API key was requested

There is no single AWS "API password" that should be pasted into ChatGPT or into the website. For an AWS-hosted Controller, the safer design is IAM roles + short-lived credentials. During deployment you sign in to your AWS account yourself in the AWS Console/CloudShell. CloudFormation creates the roles and permissions in your account.

**Do not send AWS Access Key ID, Secret Access Key, root password, MFA seed, or recovery codes in chat.**

## TEST authentication warning

The TEST site reuses the temporary Architect token stored in browser session storage. This is acceptable only while you are personally testing the system and not giving the site to clients. Before a real client can click Apply, we must replace this with real client authentication (for example API Gateway JWT authorization / Amazon Cognito / WebAuthn-backed session) and server-side budget/policy checks.

## Files

- `index.html` — TEST web UI.
- `EWS_PROJECT_SOURCE_CURRENT.html` — same TEST UI source.
- `controller_app.py` — Lambda Controller.
- `controller_template.yaml` — shared TEST control plane/network.
- `project_stack.yaml` — per-project worker stack.
- `controller_lambda.zip` — Lambda artifact.
- `controller_deploy.sh` — CloudShell deployment helper.
- `controller_tests.py` — local structural tests.

## Cost warning

`Apply` creates a real EC2 instance after deployment. Even `t3.micro` can incur AWS charges. Do not repeatedly press Apply until we add quota and budget controls and verify termination works.


## TEST pricing catalog

The Controller now owns a versioned TEST pricing snapshot (`pricing_catalog.json`) and exposes it at `GET /pricing`. The client Request screen and Architect Controller screen show the same values. `POST /projects/apply` accepts a `budget_limit_usd` and refuses the request if the cap is already below the estimated first worker-hour cost.

Current TEST snapshot (04.09.2026, USD, eu-central-1):

- Controller at very low activity: roughly **$0.40–$2/month**.
- AWS Secrets Manager: roughly **$0.40 per secret/month**.
- `t3.micro` Frankfurt compute: roughly **$0.012/hour** or **$8.76/730h**.
- 8 GB `gp3`: roughly **$0.76/month**.
- First TEST worker hour (compute + prorated 8 GB gp3): roughly **$0.0131**.
- CloudFormation orchestration: **$0 extra fee for standard AWS resources**; resources it creates are still billed.

These values are **estimates, not a billing authority**. Taxes, data transfer, public IPv4 if later enabled, snapshots, and future services are excluded. Before production client billing, replace the static snapshot with the AWS Price List API (or another verified live AWS pricing feed), then apply EWS pricing/margin rules and client-approved budgets.

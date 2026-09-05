import json
import os
import hmac
import logging
import math
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict

import boto3

VERSION = os.getenv("VERSION", "0.3.0-test")
STATE_TABLE = os.environ["STATE_TABLE"]
ADMIN_SECRET_ARN = os.environ["ADMIN_SECRET_ARN"]
ALLOWED_ORIGIN = os.getenv("ALLOWED_ORIGIN", "*")
PROJECT_STACK_ROLE_ARN = os.environ["PROJECT_STACK_ROLE_ARN"]
WORKER_SUBNET_ID = os.environ["WORKER_SUBNET_ID"]
WORKER_SECURITY_GROUP_ID = os.environ["WORKER_SECURITY_GROUP_ID"]
WORKER_INSTANCE_TYPE = os.getenv("WORKER_INSTANCE_TYPE", "t3.micro")
PROJECT_TEMPLATE_FILE = os.getenv("PROJECT_TEMPLATE_FILE", "project_stack.yaml")
PRICING_CATALOG_FILE = os.getenv("PRICING_CATALOG_FILE", "pricing_catalog.json")
PROJECT_TTL_HOURS = min(max(int(os.getenv("PROJECT_TTL_HOURS", "6")), 1), 24)

log = logging.getLogger()
log.setLevel(logging.INFO)

dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(STATE_TABLE)
secrets = boto3.client("secretsmanager")
sts = boto3.client("sts")
cfn = boto3.client("cloudformation")
_cached_admin_token = None
_cached_project_template = None

PRICING_CATALOG = json.loads(Path(__file__).with_name(PRICING_CATALOG_FILE).read_text(encoding="utf-8"))


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def response(status: int, body: Dict[str, Any], event: Dict[str, Any] | None = None):
    origin = ((event or {}).get("headers") or {}).get("origin") or ((event or {}).get("headers") or {}).get("Origin")
    cors_origin = ALLOWED_ORIGIN if ALLOWED_ORIGIN == "*" or origin == ALLOWED_ORIGIN else ALLOWED_ORIGIN
    return {
        "statusCode": status,
        "headers": {
            "content-type": "application/json",
            "access-control-allow-origin": cors_origin,
            "access-control-allow-headers": "authorization,content-type,x-ews-admin-token",
            "access-control-allow-methods": "GET,POST,OPTIONS",
            "cache-control": "no-store",
        },
        "body": json.dumps(body, ensure_ascii=False, default=str),
    }


def route_of(event: Dict[str, Any]):
    context = event.get("requestContext", {})
    http = context.get("http", {})
    method = (http.get("method") or event.get("httpMethod") or "GET").upper()
    path = http.get("path") or event.get("rawPath") or event.get("path") or "/"
    return method, path.rstrip("/") or "/"


def load_admin_token() -> str:
    global _cached_admin_token
    if _cached_admin_token:
        return _cached_admin_token
    value = secrets.get_secret_value(SecretId=ADMIN_SECRET_ARN).get("SecretString", "")
    try:
        parsed = json.loads(value)
        token = parsed.get("token", "")
    except json.JSONDecodeError:
        token = value
    if not token:
        raise RuntimeError("Admin token secret is empty")
    _cached_admin_token = token
    return token


def authorized(event: Dict[str, Any]) -> bool:
    headers = {str(k).lower(): str(v) for k, v in (event.get("headers") or {}).items()}
    supplied = headers.get("x-ews-admin-token", "")
    auth = headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        supplied = auth[7:].strip()
    return bool(supplied) and hmac.compare_digest(supplied, load_admin_token())


def get_state() -> Dict[str, Any]:
    item = table.get_item(Key={"pk": "CONTROLLER"}).get("Item")
    return item or {"pk": "CONTROLLER", "controller_state": "PAUSED", "updated_at": None, "updated_by": "safe-default"}


def set_state(state: str, actor: str) -> Dict[str, Any]:
    item = {"pk": "CONTROLLER", "controller_state": state, "updated_at": utc_now(), "updated_by": actor, "version": VERSION}
    table.put_item(Item=item)
    log.info(json.dumps({"event": "controller_state_change", **item}))
    return item


def source_actor(event: Dict[str, Any]) -> str:
    return event.get("requestContext", {}).get("http", {}).get("sourceIp", "architect-web")


def parse_json_body(event: Dict[str, Any]) -> Dict[str, Any]:
    raw = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        import base64
        raw = base64.b64decode(raw).decode("utf-8")
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        return {}


def project_id_now() -> str:
    return "p-" + datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-%f")[:22]


def safe_stack_name(project_id: str) -> str:
    clean = re.sub(r"[^A-Za-z0-9-]", "-", project_id).strip("-")
    clean = clean[:80]
    if not clean or not clean[0].isalpha():
        clean = "p-" + clean
    return "ews-project-" + clean


def load_project_template() -> str:
    global _cached_project_template
    if _cached_project_template is None:
        _cached_project_template = Path(__file__).with_name(PROJECT_TEMPLATE_FILE).read_text(encoding="utf-8")
    return _cached_project_template


def project_key(project_id: str) -> str:
    return "PROJECT#" + project_id


def save_project(item: Dict[str, Any]) -> None:
    table.put_item(Item=item)


def get_project(project_id: str) -> Dict[str, Any] | None:
    return table.get_item(Key={"pk": project_key(project_id)}).get("Item")


def create_project_stack(project_id: str, task: str) -> Dict[str, Any]:
    stack_name = safe_stack_name(project_id)
    result = cfn.create_stack(
        StackName=stack_name,
        TemplateBody=load_project_template(),
        RoleARN=PROJECT_STACK_ROLE_ARN,
        Parameters=[
            {"ParameterKey": "ProjectId", "ParameterValue": project_id},
            {"ParameterKey": "WorkerSubnetId", "ParameterValue": WORKER_SUBNET_ID},
            {"ParameterKey": "WorkerSecurityGroupId", "ParameterValue": WORKER_SECURITY_GROUP_ID},
            {"ParameterKey": "InstanceType", "ParameterValue": WORKER_INSTANCE_TYPE},
        ],
        Tags=[
            {"Key": "EWSManaged", "Value": "true"},
            {"Key": "EWSMode", "Value": "TEST"},
            {"Key": "EWSProjectId", "Value": project_id},
        ],
        OnFailure="DELETE",
        EnableTerminationProtection=False,
    )
    return {"stack_name": stack_name, "stack_id": result["StackId"]}


def stack_status(stack_name: str) -> Dict[str, Any]:
    stacks = cfn.describe_stacks(StackName=stack_name).get("Stacks", [])
    if not stacks:
        return {"stack_status": "UNKNOWN"}
    s = stacks[0]
    outputs = {x["OutputKey"]: x.get("OutputValue") for x in s.get("Outputs", [])}
    return {"stack_status": s.get("StackStatus"), "worker_instance_id": outputs.get("WorkerInstanceId")}


def project_price_estimate(body: Dict[str, Any]) -> Dict[str, Any]:
    limits = {
        "labor_hours": 100000.0,
        "labor_rate_usd": 10000.0,
        "aws_runtime_hours": 8760.0,
        "storage_gb": 100000.0,
        "reserve_usd": 10000000.0,
    }
    values: Dict[str, float] = {}
    for field, maximum in limits.items():
        raw = body.get(field, 0)
        if isinstance(raw, bool):
            raise ValueError(f"{field} must be a finite number from 0 to {maximum:g}")
        try:
            value = float(raw)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{field} must be a finite number from 0 to {maximum:g}") from exc
        if not math.isfinite(value) or value < 0 or value > maximum:
            raise ValueError(f"{field} must be a finite number from 0 to {maximum:g}")
        values[field] = value

    raw_workers = body.get("aws_workers", 1)
    if isinstance(raw_workers, bool):
        raise ValueError("aws_workers must be an integer from 1 to 100")
    try:
        workers = int(raw_workers)
    except (TypeError, ValueError) as exc:
        raise ValueError("aws_workers must be an integer from 1 to 100") from exc
    if workers < 1 or workers > 100 or float(raw_workers) != workers:
        raise ValueError("aws_workers must be an integer from 1 to 100")

    worker = PRICING_CATALOG["worker"]
    labor = values["labor_hours"] * values["labor_rate_usd"]
    compute = workers * values["aws_runtime_hours"] * float(worker["hourly_compute_usd"])
    storage = values["storage_gb"] * (float(worker["gp3_storage_month_usd"]) / float(worker["gp3_storage_gb"])) * (values["aws_runtime_hours"] / 730)
    total = labor + compute + storage + values["reserve_usd"]
    return {
        "currency": PRICING_CATALOG["currency"],
        "pricing_snapshot_date": PRICING_CATALOG["snapshot_date"],
        "pricing_mode": PRICING_CATALOG["mode"],
        "inputs": {**values, "aws_workers": workers},
        "breakdown": {
            "labor_usd": round(labor, 6),
            "aws_compute_usd": round(compute, 6),
            "aws_storage_usd": round(storage, 6),
            "reserve_usd": round(values["reserve_usd"], 6),
        },
        "total_usd": round(total, 6),
        "is_final_invoice": False,
    }


def cleanup_expired_projects(now: datetime | None = None) -> Dict[str, int]:
    """Delete expired TEST stacks; scheduled retries make cleanup eventually consistent."""
    now_epoch = int((now or datetime.now(timezone.utc)).timestamp())
    deleted = 0
    failed = 0
    scan_kwargs: Dict[str, Any] = {
        "FilterExpression": "begins_with(pk, :prefix) AND expires_at_epoch <= :now",
        "ExpressionAttributeValues": {":prefix": "PROJECT#", ":now": now_epoch},
        "ProjectionExpression": "pk, stack_name, #status",
        "ExpressionAttributeNames": {"#status": "status"},
    }
    while True:
        page = table.scan(**scan_kwargs)
        for item in page.get("Items", []):
            if item.get("status") in {"TERMINATING", "TERMINATED"}:
                continue
            try:
                cfn.delete_stack(StackName=item["stack_name"], RoleARN=PROJECT_STACK_ROLE_ARN)
                table.update_item(
                    Key={"pk": item["pk"]},
                    UpdateExpression="SET #status = :status, updated_at = :updated",
                    ExpressionAttributeNames={"#status": "status"},
                    ExpressionAttributeValues={":status": "TERMINATING", ":updated": utc_now()},
                )
                deleted += 1
            except Exception:
                failed += 1
                log.exception("scheduled project cleanup failed", extra={"project_key": item.get("pk")})
        cursor = page.get("LastEvaluatedKey")
        if not cursor:
            break
        scan_kwargs["ExclusiveStartKey"] = cursor
    return {"expired_stacks_deleted": deleted, "cleanup_failures": failed}


def lambda_handler(event, context):
    if event.get("source") == "aws.events" and event.get("detail-type") == "Scheduled Event":
        return {"ok": True, **cleanup_expired_projects()}

    method, path = route_of(event)

    if method == "OPTIONS":
        return response(204, {}, event)

    if method == "GET" and path == "/pricing":
        return response(200, {"ok": True, "pricing": PRICING_CATALOG}, event)

    if method == "GET" and path == "/health":
        state = get_state()
        return response(200, {
            "ok": True,
            "service": "ews-controller-test",
            "version": VERSION,
            "controller_state": state["controller_state"],
            "region": os.getenv("AWS_REGION", "unknown"),
            "time": utc_now(),
            "provisioning": "cloudformation-test",
            "direct_ec2_permission": False,
        }, event)

    # TEST build: every state-changing/project route requires the temporary Architect token.
    # Production client Apply must use real client authentication (e.g. JWT/Cognito), never this token in public JS.
    if not authorized(event):
        return response(401, {"ok": False, "error": "unauthorized", "message": "TEST session token required"}, event)

    if method == "POST" and path == "/pricing/estimate":
        try:
            estimate = project_price_estimate(parse_json_body(event))
        except ValueError as exc:
            return response(400, {"ok": False, "error": "invalid_estimate_input", "message": str(exc)}, event)
        return response(200, {"ok": True, "estimate": estimate}, event)

    if method == "GET" and path == "/controller/status":
        state = get_state()
        return response(200, {"ok": True, **state, "version": VERSION, "provisioning": "cloudformation-test"}, event)

    if method == "POST" and path == "/controller/start":
        return response(200, {"ok": True, **set_state("ENABLED", source_actor(event))}, event)

    if method == "POST" and path == "/controller/stop":
        return response(200, {"ok": True, **set_state("PAUSED", source_actor(event))}, event)

    if method == "POST" and path == "/controller/aws-check":
        ident = sts.get_caller_identity()
        return response(200, {
            "ok": True,
            "controller": "ews-controller-test-v0.3",
            "region": os.getenv("AWS_REGION", "unknown"),
            "account": ident.get("Account"),
            "arn": ident.get("Arn"),
            "provisioning": "CloudFormation execution role",
            "direct_ec2_permission": False,
        }, event)

    if method == "POST" and path == "/runs/plan":
        state = get_state()
        if state["controller_state"] != "ENABLED":
            return response(409, {"ok": False, "error": "controller_paused", "message": "Start Controller first"}, event)
        body = parse_json_body(event)
        task = str(body.get("task", "")).strip()
        if not task:
            return response(400, {"ok": False, "error": "task_required"}, event)
        return response(200, {
            "ok": True,
            "run_id": "plan-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"),
            "task_received": task[:500],
            "worker_count": 1,
            "worker_launch": False,
            "execution_mode": "PLAN_ONLY",
            "sandbox": "REQUIRED",
            "network_default": "OFF",
            "pricing_snapshot": PRICING_CATALOG,
            "estimated_first_hour_usd": PRICING_CATALOG["worker"]["estimated_first_hour_usd"],
        }, event)

    if method == "POST" and path == "/projects/apply":
        state = get_state()
        if state["controller_state"] != "ENABLED":
            return response(409, {"ok": False, "error": "controller_paused", "message": "Start Controller before Apply"}, event)
        body = parse_json_body(event)
        task = str(body.get("task", "")).strip()
        if not task:
            return response(400, {"ok": False, "error": "task_required"}, event)
        raw_budget = body.get("budget_limit_usd", 1.0)
        if isinstance(raw_budget, bool):
            return response(400, {"ok": False, "error": "invalid_budget", "message": "budget_limit_usd must be a finite positive number"}, event)
        try:
            budget_limit_usd = float(raw_budget)
        except (TypeError, ValueError):
            return response(400, {"ok": False, "error": "invalid_budget", "message": "budget_limit_usd must be a finite positive number"}, event)
        if not math.isfinite(budget_limit_usd) or budget_limit_usd <= 0:
            return response(400, {"ok": False, "error": "invalid_budget", "message": "budget_limit_usd must be a finite positive number"}, event)
        first_hour = PRICING_CATALOG["worker"]["estimated_first_hour_usd"]
        if budget_limit_usd < first_hour:
            return response(402, {
                "ok": False,
                "error": "budget_too_low",
                "message": "TEST budget is below the estimated first-hour worker cost",
                "estimated_first_hour_usd": first_hour,
                "budget_limit_usd": budget_limit_usd,
            }, event)
        raw_ttl = body.get("ttl_hours", PROJECT_TTL_HOURS)
        try:
            if isinstance(raw_ttl, bool) or isinstance(raw_ttl, float) and not raw_ttl.is_integer():
                raise ValueError
            if isinstance(raw_ttl, str) and not re.fullmatch(r"[0-9]+", raw_ttl):
                raise ValueError
            ttl_hours = int(raw_ttl)
        except (TypeError, ValueError):
            return response(400, {"ok": False, "error": "invalid_ttl", "message": "ttl_hours must be an integer from 1 to 24"}, event)
        if ttl_hours < 1 or ttl_hours > 24:
            return response(400, {"ok": False, "error": "invalid_ttl", "message": "ttl_hours must be an integer from 1 to 24"}, event)
        project_id = project_id_now()
        created = create_project_stack(project_id, task)
        created_at = datetime.now(timezone.utc)
        expires_at = created_at + timedelta(hours=ttl_hours)
        item = {
            "pk": project_key(project_id),
            "project_id": project_id,
            "task": task[:2000],
            "status": "PROVISIONING",
            "stack_name": created["stack_name"],
            "stack_id": created["stack_id"],
            "created_at": created_at.isoformat(),
            "expires_at": expires_at.isoformat(),
            "expires_at_epoch": int(expires_at.timestamp()),
            "ttl_hours": ttl_hours,
            "source": str(body.get("source", "test"))[:100],
            "worker_count_requested": 1,
            "network_default": "OFF",
            "mode": "TEST",
            "budget_limit_usd": budget_limit_usd,
            "estimated_first_hour_usd": first_hour,
            "pricing_snapshot_date": PRICING_CATALOG["snapshot_date"],
        }
        save_project(item)
        log.info(json.dumps({"event": "project_apply", **item}))
        return response(202, {"ok": True, **item}, event)

    m = re.fullmatch(r"/projects/([A-Za-z0-9._-]+)", path)
    if method == "GET" and m:
        project_id = m.group(1)
        item = get_project(project_id)
        if not item:
            return response(404, {"ok": False, "error": "project_not_found"}, event)
        try:
            aws = stack_status(item["stack_name"])
        except Exception as exc:
            aws = {"stack_status": "LOOKUP_ERROR", "detail": str(exc)[:300]}
        return response(200, {"ok": True, **item, **aws}, event)

    m = re.fullmatch(r"/projects/([A-Za-z0-9._-]+)/terminate", path)
    if method == "POST" and m:
        project_id = m.group(1)
        item = get_project(project_id)
        if not item:
            return response(404, {"ok": False, "error": "project_not_found"}, event)
        cfn.delete_stack(StackName=item["stack_name"], RoleARN=PROJECT_STACK_ROLE_ARN)
        item["status"] = "TERMINATING"
        item["updated_at"] = utc_now()
        save_project(item)
        return response(202, {"ok": True, **item}, event)

    return response(404, {"ok": False, "error": "not_found", "path": path, "method": method}, event)

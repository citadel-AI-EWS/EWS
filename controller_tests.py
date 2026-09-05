import ast
import importlib
import json
import os
import pathlib
import sys
import types
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).parent


class FakeTable:
    def __init__(self):
        self.items = {}

    def get_item(self, Key):
        item = self.items.get(Key["pk"])
        return {"Item": item} if item else {}

    def put_item(self, Item):
        self.items[Item["pk"]] = Item

    def scan(self, **_kwargs):
        now = _kwargs["ExpressionAttributeValues"][":now"]
        return {"Items": [
            {"pk": item["pk"], "stack_name": item["stack_name"], "status": item["status"]}
            for item in self.items.values()
            if item.get("pk", "").startswith("PROJECT#") and item.get("expires_at_epoch", now + 1) <= now
        ]}

    def update_item(self, Key, **_kwargs):
        self.items[Key["pk"]]["status"] = _kwargs["ExpressionAttributeValues"][":status"]
        self.items[Key["pk"]]["updated_at"] = _kwargs["ExpressionAttributeValues"][":updated"]


class FakeBoto3(types.ModuleType):
    def __init__(self):
        super().__init__("boto3")
        self.table = FakeTable()

    def resource(self, name):
        return types.SimpleNamespace(Table=lambda _name: self.table)

    def client(self, name):
        return types.SimpleNamespace()


class TestPackage(unittest.TestCase):
    def test_controller_syntax(self):
        ast.parse((ROOT / "controller_app.py").read_text(encoding="utf-8"))

    def test_project_template_is_packaged(self):
        self.assertIn("AWS::EC2::Instance", (ROOT / "project_stack.yaml").read_text(encoding="utf-8"))

    def test_control_plane_template_is_packaged(self):
        template = (ROOT / "controller_template.yaml").read_text(encoding="utf-8")
        self.assertIn("AWS::Serverless::Function", template)
        self.assertIn("VERSION: 0.3.0-test", template)

    def test_apply_route_exists(self):
        code = (ROOT / "controller_app.py").read_text(encoding="utf-8")
        self.assertIn("/projects/apply", code)
        self.assertIn("cloudformation", code)

    def test_pricing_catalog_matches_controller_snapshot(self):
        pricing = json.loads((ROOT / "pricing_catalog.json").read_text(encoding="utf-8"))
        self.assertEqual(pricing["worker"]["instance_type"], "t3.micro")
        self.assertAlmostEqual(pricing["worker"]["hourly_compute_usd"], 0.012)
        code = (ROOT / "controller_app.py").read_text(encoding="utf-8")
        self.assertIn("/pricing", code)
        self.assertIn("budget_limit_usd", code)

    def test_architect_only_site_and_price_stage_exist(self):
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        self.assertNotIn('id="clientLogin"', html)
        self.assertNotIn('class="client-section', html)
        self.assertNotIn("loginClient()", html)
        self.assertNotIn("const clientNav", html)
        self.assertIn("ARCHITECT ONLY", html)
        self.assertIn("applyProjectFromArchitect()", html)
        self.assertIn('id="w5"', html)
        self.assertIn("calculateProjectPrice()", html)
        self.assertIn('id="priceGrandTotal"', html)
        self.assertIn("TEST ONLY", html)

    def test_html_snapshots_are_identical(self):
        self.assertEqual(
            (ROOT / "index.html").read_bytes(),
            (ROOT / "EWS_PROJECT_SOURCE_CURRENT.html").read_bytes(),
        )


class TestControllerBudgetValidation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fake_boto3 = FakeBoto3()
        env = {
            "STATE_TABLE": "state",
            "ADMIN_SECRET_ARN": "secret",
            "PROJECT_STACK_ROLE_ARN": "role",
            "WORKER_SUBNET_ID": "subnet",
            "WORKER_SECURITY_GROUP_ID": "sg",
        }
        with mock.patch.dict(os.environ, env), mock.patch.dict(sys.modules, {"boto3": cls.fake_boto3}):
            sys.modules.pop("controller_app", None)
            cls.app = importlib.import_module("controller_app")
        cls.app.authorized = lambda _event: True
        cls.fake_boto3.table.put_item(Item={"pk": "CONTROLLER", "controller_state": "ENABLED"})

    def call_apply(self, budget):
        event = {
            "requestContext": {"http": {"method": "POST", "path": "/projects/apply"}},
            "headers": {},
            "body": json.dumps({"task": "xplace sample", "budget_limit_usd": budget}),
        }
        return self.app.lambda_handler(event, None)

    def test_rejects_non_numeric_budget_without_server_error(self):
        result = self.call_apply("not-a-number")
        self.assertEqual(result["statusCode"], 400)
        self.assertEqual(json.loads(result["body"])["error"], "invalid_budget")

    def test_rejects_non_finite_and_non_positive_budgets(self):
        for budget in ("NaN", "Infinity", 0, -1, True):
            with self.subTest(budget=budget):
                self.assertEqual(self.call_apply(budget)["statusCode"], 400)

    def test_rejects_budget_below_first_hour(self):
        result = self.call_apply(0.01)
        self.assertEqual(result["statusCode"], 402)
        self.assertEqual(json.loads(result["body"])["error"], "budget_too_low")

    def test_rejects_invalid_worker_ttl_before_provisioning(self):
        for ttl in (0, 25, "invalid", 1.5, True):
            with self.subTest(ttl=ttl):
                event = {
                    "requestContext": {"http": {"method": "POST", "path": "/projects/apply"}},
                    "headers": {},
                    "body": json.dumps({"task": "safe test", "budget_limit_usd": 1, "ttl_hours": ttl}),
                }
                result = self.app.lambda_handler(event, None)
                self.assertEqual(result["statusCode"], 400)
                self.assertEqual(json.loads(result["body"])["error"], "invalid_ttl")

    def test_scheduled_cleanup_terminates_expired_stack(self):
        deleted = []
        self.app.cfn = types.SimpleNamespace(delete_stack=lambda **kwargs: deleted.append(kwargs))
        self.fake_boto3.table.put_item(Item={
            "pk": "PROJECT#expired",
            "stack_name": "ews-project-expired",
            "status": "PROVISIONING",
            "expires_at_epoch": 1,
            "task": "preserved",
        })
        result = self.app.lambda_handler(
            {"source": "aws.events", "detail-type": "Scheduled Event"}, None
        )
        self.assertEqual(result["expired_stacks_deleted"], 1)
        self.assertEqual(len(deleted), 1)
        item = self.fake_boto3.table.items["PROJECT#expired"]
        self.assertEqual(item["status"], "TERMINATING")
        self.assertEqual(item["task"], "preserved")

    def test_xplace_sample_runs_as_plan_only(self):
        task = (
            "Prepare an approximately 20-screen investor presentation for a "
            "cybersecurity startup using its existing branding."
        )
        event = {
            "requestContext": {"http": {"method": "POST", "path": "/runs/plan"}},
            "headers": {},
            "body": json.dumps({"task": task}),
        }
        result = self.app.lambda_handler(event, None)
        body = json.loads(result["body"])
        self.assertEqual(result["statusCode"], 200)
        self.assertEqual(body["execution_mode"], "PLAN_ONLY")
        self.assertFalse(body["worker_launch"])
        self.assertEqual(body["task_received"], task)


if __name__ == "__main__":
    unittest.main()

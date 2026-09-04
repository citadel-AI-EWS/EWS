import ast
import pathlib
import re
import unittest
import json

ROOT = pathlib.Path(__file__).parent

class TestPackage(unittest.TestCase):
    def test_controller_syntax(self):
        ast.parse((ROOT / 'controller_app.py').read_text())

    def test_project_template_is_packaged(self):
        self.assertIn('AWS::EC2::Instance', (ROOT / 'project_stack.yaml').read_text())

    def test_apply_route_exists(self):
        code=(ROOT / 'controller_app.py').read_text()
        self.assertIn('/projects/apply', code)
        self.assertIn('cloudformation', code)

    def test_pricing_catalog(self):
        pricing=json.loads((ROOT / 'pricing_catalog.json').read_text())
        self.assertEqual(pricing['worker']['instance_type'], 't3.micro')
        self.assertAlmostEqual(pricing['worker']['hourly_compute_usd'], 0.012)
        code=(ROOT / 'controller_app.py').read_text()
        self.assertIn('/pricing', code)
        self.assertIn('budget_limit_usd', code)

    def test_test_site_apply_exists(self):
        html=(ROOT / 'index.html').read_text()
        self.assertIn('applyProjectFromClient()', html)
        self.assertIn('TEST ONLY', html)

if __name__ == '__main__':
    unittest.main()

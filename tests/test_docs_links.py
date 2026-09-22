"""
Documentation Link Tests
========================

Tests for the in-repository anchor links in ``README.md`` and in the issue
template configuration. GitHub resolves a heading anchor silently: a renamed
heading leaves the link in place and scrolls nowhere, so the issue template
that funnels antivirus reports into the README would stop funnelling without
any visible failure.
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

from usage_monitor_for_claude.claude_cli import PROJECT_URL

REPOSITORY = Path(__file__).resolve().parent.parent
README = REPOSITORY / 'README.md'
ISSUE_TEMPLATE_CONFIG = REPOSITORY / '.github' / 'ISSUE_TEMPLATE' / 'config.yml'

# Taken from the app rather than spelled out again: the tray menu and the
# issue template must point at the same repository, and a fork that renames
# itself should not have to remember this file.
REPOSITORY_URL = PROJECT_URL


def _readme_anchors() -> set[str]:
    """Return the anchor GitHub generates for every heading in the README, skipping fenced code blocks."""
    anchors = set()
    inside_fence = False

    for line in README.read_text(encoding='utf-8').split('\n'):
        if line.startswith('```'):
            inside_fence = not inside_fence
            continue

        if inside_fence:
            continue

        heading = re.match(r'^#{1,6}\s+(.*)$', line)
        if heading:
            anchors.add(re.sub(r'[^a-z0-9 -]', '', heading.group(1).lower()).replace(' ', '-'))

    return anchors


class TestReadmeAnchors(unittest.TestCase):
    def test_internal_links_resolve(self):
        anchors = _readme_anchors()
        text = README.read_text(encoding='utf-8')

        for anchor in re.findall(r'\]\(#([^)]*)\)', text):
            self.assertIn(anchor, anchors, f'README.md links to #{anchor}, which no heading produces')

    def test_antivirus_section_exists(self):
        self.assertIn('antivirus-warnings', _readme_anchors())


class TestIssueTemplateConfig(unittest.TestCase):
    def test_contact_links_into_the_readme_resolve(self):
        anchors = _readme_anchors()
        text = ISSUE_TEMPLATE_CONFIG.read_text(encoding='utf-8')
        links = re.findall(rf'{re.escape(REPOSITORY_URL)}#([^\s]*)', text)

        self.assertTrue(links, 'the issue template no longer points readers at a README section')

        for anchor in links:
            self.assertIn(anchor, anchors, f'the issue template links to #{anchor}, which no heading produces')

    def test_every_contact_link_has_a_name_and_a_url(self):
        text = ISSUE_TEMPLATE_CONFIG.read_text(encoding='utf-8')

        self.assertEqual(len(re.findall(r'^  - name: ', text, re.MULTILINE)), len(re.findall(r'^    url: ', text, re.MULTILINE)))


if __name__ == '__main__':
    unittest.main()

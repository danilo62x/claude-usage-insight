"""Tests for the session index aggregations and the panel's geometry state."""
from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from usage_monitor_for_claude.sessions import queries, scanner


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')


class _IndexFixture(unittest.TestCase):
    """Builds a small in-memory index instead of touching real transcripts."""

    def setUp(self) -> None:
        self.conn = sqlite3.connect(':memory:')
        self.conn.row_factory = sqlite3.Row
        scanner.init_db(self.conn)
        self.base = datetime(2026, 9, 21, 12, 0, tzinfo=timezone.utc)

    def tearDown(self) -> None:
        self.conn.close()

    def add_turn(self, session_id: str, *, minute: int = 0, inp: int = 0, out: int = 0,
                 cache_read: int = 0, cache_creation: int = 0, subagent: int = 0,
                 model: str = 'claude-opus-5') -> None:
        self.conn.execute(
            'INSERT INTO turns (session_id, timestamp, model, input_tokens, output_tokens,'
            ' cache_read_tokens, cache_creation_tokens, is_subagent)'
            ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            (session_id, _iso(self.base + timedelta(minutes=minute)), model,
             inp, out, cache_read, cache_creation, subagent),
        )

    def add_session(self, session_id: str, project: str, topic: str = '') -> None:
        self.conn.execute(
            'INSERT INTO sessions (session_id, project_name, topic) VALUES (?, ?, ?)',
            (session_id, project, topic),
        )


class TestWeighting(_IndexFixture):
    def test_weights_match_the_published_price_ratios(self) -> None:
        """One token of each class must weigh 1 + 1.25 + 0.1 + 5."""
        self.add_session('s1', 'proj')
        self.add_turn('s1', inp=1, cache_creation=1, cache_read=1, out=1)

        row = queries.sessions(self.conn)[0]
        self.assertEqual(row['raw'], 4)
        self.assertEqual(row['weighted'], int(1 + 1.25 + 0.1 + 5))

    def test_cache_reads_are_cheap_relative_to_their_volume(self) -> None:
        """A cache-read-heavy session must rank below a smaller output-heavy one.

        This is the whole reason the panel sorts on weighted tokens: raw totals
        would put the cache-heavy session first.
        """
        self.add_session('cache', 'proj')
        self.add_session('output', 'proj')
        self.add_turn('cache', cache_read=1_000_000)
        self.add_turn('output', out=50_000)

        rows = queries.sessions(self.conn)
        self.assertEqual(rows[0]['session_id'], 'output')
        self.assertGreater(rows[1]['raw'], rows[0]['raw'])


class TestSessions(_IndexFixture):
    def test_context_average_and_peak_exclude_output(self) -> None:
        """Context is what the turn was billed to read, not what it produced."""
        self.add_session('s1', 'proj')
        self.add_turn('s1', minute=0, inp=10, cache_read=90, out=1000)
        self.add_turn('s1', minute=1, inp=10, cache_read=190, out=1000)

        row = queries.sessions(self.conn)[0]
        self.assertEqual(row['ctx_peak'], 200)
        self.assertEqual(row['ctx_avg'], 150)

    def test_subagent_cost_is_reported_separately(self) -> None:
        """Subagent turns count in the total and again in their own column."""
        self.add_session('s1', 'proj')
        self.add_turn('s1', minute=0, out=100)
        self.add_turn('s1', minute=1, out=300, subagent=1)

        row = queries.sessions(self.conn)[0]
        self.assertEqual(row['turns'], 2)
        self.assertEqual(row['sub_turns'], 1)
        self.assertEqual(row['sub_weighted'], 300 * 5)
        self.assertEqual(row['weighted'], 400 * 5)

    def test_date_filter_uses_local_time(self) -> None:
        """A turn late in the UTC day belongs to the previous local day at -03."""
        self.base = datetime(2026, 9, 22, 1, 30, tzinfo=timezone.utc)
        self.add_session('s1', 'proj')
        self.add_turn('s1', out=10)

        self.assertEqual(len(queries.sessions(self.conn, since='2026-09-22', tz_offset_minutes=0)), 1)
        self.assertEqual(len(queries.sessions(self.conn, since='2026-09-22', tz_offset_minutes=-180)), 0)
        self.assertEqual(
            len(queries.sessions(self.conn, since='2026-09-21', until='2026-09-22', tz_offset_minutes=-180)), 1)


class TestCostCurve(_IndexFixture):
    def test_blocks_average_cost_and_context_together(self) -> None:
        """Turns are grouped in fixed blocks, in chronological order."""
        self.add_session('s1', 'proj')
        for i in range(4):
            self.add_turn('s1', minute=i, cache_read=1000 * (i + 1), out=100)

        blocks = queries.cost_curve(self.conn, 's1', block=2)
        self.assertEqual([b['turn_from'] for b in blocks], [0, 2])
        self.assertEqual([b['turns'] for b in blocks], [2, 2])
        # context climbs across the blocks, which is what the chart plots
        self.assertLess(blocks[0]['context_avg'], blocks[1]['context_avg'])

    def test_unknown_session_yields_no_blocks(self) -> None:
        self.assertEqual(queries.cost_curve(self.conn, 'missing'), [])


class TestQuotaWindow(_IndexFixture):
    def test_only_turns_inside_the_window_are_attributed(self) -> None:
        """The window is the *hours* preceding the reset, half-open at the end."""
        self.add_session('inside', 'proj')
        self.add_session('outside', 'proj')
        resets_at = (self.base + timedelta(hours=1)).timestamp()
        self.add_turn('inside', minute=0, out=100)
        self.add_turn('outside', minute=-400, out=100)  # ~6.6h before the window

        rows = queries.quota_window(self.conn, hours=5, resets_at=resets_at)
        self.assertEqual([r['session_id'] for r in rows], ['inside'])

    def test_rows_are_ranked_by_weighted_cost(self) -> None:
        self.add_session('small', 'proj')
        self.add_session('big', 'proj')
        self.add_turn('small', out=10)
        self.add_turn('big', out=500)

        rows = queries.quota_window(self.conn, hours=5, resets_at=(self.base + timedelta(hours=1)).timestamp())
        self.assertEqual([r['session_id'] for r in rows], ['big', 'small'])


class TestPanelGeometry(unittest.TestCase):
    def test_defaults_survive_a_corrupt_state_file(self) -> None:
        """A bad remembered size must never stop the panel from opening."""
        from usage_monitor_for_claude import panel

        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / 'usage-monitor-panel.json'
            state.write_text('{ not json', encoding='utf-8')
            original = panel._state_path
            panel._state_path = lambda: state  # type: ignore[assignment]
            try:
                self.assertEqual(panel.load_geometry()['width'], panel._DEFAULT_GEOMETRY['width'])
            finally:
                panel._state_path = original  # type: ignore[assignment]

    def test_stored_size_is_clamped_to_the_minimum(self) -> None:
        """A window dragged smaller than usable must come back usable."""
        from usage_monitor_for_claude import panel

        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / 'usage-monitor-panel.json'
            state.write_text(json.dumps({'width': 10, 'height': 10, 'x': 5, 'y': 6}), encoding='utf-8')
            original = panel._state_path
            panel._state_path = lambda: state  # type: ignore[assignment]
            try:
                geometry = panel.load_geometry()
                self.assertEqual(geometry['width'], panel._MIN_SIZE[0])
                self.assertEqual(geometry['height'], panel._MIN_SIZE[1])
                self.assertEqual((geometry['x'], geometry['y']), (5, 6))
            finally:
                panel._state_path = original  # type: ignore[assignment]

    def test_reset_epoch_accepts_iso_and_numbers(self) -> None:
        from usage_monitor_for_claude.panel import _reset_epoch

        self.assertEqual(_reset_epoch(1790000000), 1790000000.0)
        self.assertEqual(
            _reset_epoch('2026-09-21T15:00:00Z'),
            datetime(2026, 9, 21, 15, 0, tzinfo=timezone.utc).timestamp(),
        )
        self.assertIsNone(_reset_epoch('not a date'))
        self.assertIsNone(_reset_epoch(None))


if __name__ == '__main__':
    unittest.main()

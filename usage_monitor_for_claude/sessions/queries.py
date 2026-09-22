"""Aggregations over the session index, for the Sessions and Charts panels.

The index itself is built by the vendored ``scanner`` module; everything here is
read-only SQL over its ``sessions`` / ``turns`` tables.

Two derived numbers are used throughout and deserve an explanation, because the
raw token count in the transcripts is a misleading measure of what a session
actually costs:

*Weighted tokens* apply the published price ratios of the token classes, taking
plain input as the unit: cache writes cost 1.25x, cache reads 0.1x and output
5x.  On a long session upwards of 90% of the raw tokens are cache reads, so raw
totals overstate cheap sessions and understate output-heavy ones.

*Context size* is the whole prompt a turn had to be billed for -
``input + cache_creation + cache_read``.  Tracked per turn it explains why a
session gets more expensive as it grows: the same work costs a multiple once the
conversation is large, which is what the cost-curve chart shows.
"""
from __future__ import annotations

import sqlite3
from typing import Any

# Price ratios relative to plain input tokens.  Anthropic prices cache writes at
# 1.25x input, cache reads at 0.1x and output at 5x; those ratios hold across the
# current model line-up, so one set of weights is enough to rank sessions.
W_INPUT = 1.0
W_CACHE_CREATION = 1.25
W_CACHE_READ = 0.1
W_OUTPUT = 5.0

_WEIGHTED = (
    f'(t.input_tokens * {W_INPUT}'
    f' + t.cache_creation_tokens * {W_CACHE_CREATION}'
    f' + t.cache_read_tokens * {W_CACHE_READ}'
    f' + t.output_tokens * {W_OUTPUT})'
)
_RAW = '(t.input_tokens + t.cache_creation_tokens + t.cache_read_tokens + t.output_tokens)'
_CONTEXT = '(t.input_tokens + t.cache_creation_tokens + t.cache_read_tokens)'


def _local(expr: str, tz_offset_minutes: int) -> str:
    """Return *expr* shifted from stored UTC into the viewer's local time.

    Timestamps are stored as ISO-8601 UTC and SQLite has no timezone support, so
    the offset has to be applied inside the query; the panel passes the
    browser's own offset.
    """
    sign = '+' if tz_offset_minutes >= 0 else '-'
    return f"datetime({expr}, '{sign}{abs(tz_offset_minutes)} minutes')"


def _rows(conn: sqlite3.Connection, sql: str, args: tuple = ()) -> list[dict[str, Any]]:
    """Run *sql* and return the rows as plain dicts, ready for JSON."""
    cur = conn.execute(sql, args)
    cols = [c[0] for c in cur.description]
    return [dict(zip(cols, row)) for row in cur.fetchall()]


def sessions(
    conn: sqlite3.Connection,
    *,
    since: str | None = None,
    until: str | None = None,
    tz_offset_minutes: int = 0,
    limit: int = 200,
) -> list[dict[str, Any]]:
    """One row per session, most expensive first.

    Subagent turns are counted in the session totals and also reported
    separately in ``sub_weighted``: a fan-out of agents can easily outweigh the
    conversation that spawned it, and that only shows up when the two are listed
    side by side.
    """
    where = ['t.timestamp IS NOT NULL']
    args: list[Any] = []
    if since:
        where.append(f'{_local("t.timestamp", tz_offset_minutes)} >= ?')
        args.append(since)
    if until:
        where.append(f'{_local("t.timestamp", tz_offset_minutes)} < ?')
        args.append(until)

    sql = f'''
        SELECT
            t.session_id                                     AS session_id,
            COALESCE(s.project_name, '?')                    AS project,
            s.topic                                          AS topic,
            MIN({_local('t.timestamp', tz_offset_minutes)})  AS first_ts,
            MAX({_local('t.timestamp', tz_offset_minutes)})  AS last_ts,
            COUNT(*)                                         AS turns,
            SUM(t.is_subagent)                               AS sub_turns,
            CAST(SUM({_RAW}) AS INTEGER)                     AS raw,
            CAST(SUM({_WEIGHTED}) AS INTEGER)                AS weighted,
            CAST(SUM(CASE WHEN t.is_subagent THEN {_WEIGHTED} ELSE 0 END) AS INTEGER)
                                                             AS sub_weighted,
            CAST(AVG({_CONTEXT}) AS INTEGER)                 AS ctx_avg,
            CAST(MAX({_CONTEXT}) AS INTEGER)                 AS ctx_peak,
            CAST(SUM(t.output_tokens) AS INTEGER)            AS output,
            GROUP_CONCAT(DISTINCT t.model)                   AS models
        FROM turns t
        LEFT JOIN sessions s ON s.session_id = t.session_id
        WHERE {' AND '.join(where)}
        GROUP BY t.session_id
        ORDER BY weighted DESC
        LIMIT ?
    '''
    return _rows(conn, sql, (*args, limit))


def daily(conn: sqlite3.Connection, *, days: int = 30, tz_offset_minutes: int = 0) -> list[dict[str, Any]]:
    """Totals per calendar day, newest first, for the trend chart."""
    day = f"date({_local('t.timestamp', tz_offset_minutes)})"
    sql = f'''
        SELECT {day}                                  AS day,
               CAST(SUM({_RAW}) AS INTEGER)           AS raw,
               CAST(SUM({_WEIGHTED}) AS INTEGER)      AS weighted,
               CAST(SUM(t.output_tokens) AS INTEGER)  AS output,
               COUNT(*)                               AS turns,
               COUNT(DISTINCT t.session_id)           AS sessions
        FROM turns t
        WHERE t.timestamp IS NOT NULL
        GROUP BY day
        ORDER BY day DESC
        LIMIT ?
    '''
    return _rows(conn, sql, (days,))


def by_model(conn: sqlite3.Connection, *, days: int = 30, tz_offset_minutes: int = 0) -> list[dict[str, Any]]:
    """Per-day split by model, for the stacked trend chart."""
    day = f"date({_local('t.timestamp', tz_offset_minutes)})"
    sql = f'''
        SELECT {day}                             AS day,
               COALESCE(t.model, '?')            AS model,
               CAST(SUM({_WEIGHTED}) AS INTEGER) AS weighted
        FROM turns t
        WHERE t.timestamp IS NOT NULL AND {day} >= date('now', ?)
        GROUP BY day, model
        ORDER BY day
    '''
    return _rows(conn, sql, (f'-{days} days',))


def hourly(conn: sqlite3.Connection, *, days: int = 30, tz_offset_minutes: int = 0) -> list[dict[str, Any]]:
    """Weighted tokens per hour of the day, over the trailing window."""
    local = _local('t.timestamp', tz_offset_minutes)
    sql = f'''
        SELECT CAST(strftime('%H', {local}) AS INTEGER) AS hour,
               CAST(SUM({_WEIGHTED}) AS INTEGER)        AS weighted,
               COUNT(*)                                 AS turns
        FROM turns t
        WHERE t.timestamp IS NOT NULL AND date({local}) >= date('now', ?)
        GROUP BY hour
        ORDER BY hour
    '''
    return _rows(conn, sql, (f'-{days} days',))


def by_project(conn: sqlite3.Connection, *, days: int = 30, tz_offset_minutes: int = 0) -> list[dict[str, Any]]:
    """Weighted tokens per project, biggest first."""
    day = f"date({_local('t.timestamp', tz_offset_minutes)})"
    sql = f'''
        SELECT COALESCE(s.project_name, '?')     AS project,
               CAST(SUM({_WEIGHTED}) AS INTEGER) AS weighted,
               CAST(SUM({_RAW}) AS INTEGER)      AS raw,
               COUNT(DISTINCT t.session_id)      AS sessions,
               COUNT(*)                          AS turns
        FROM turns t
        LEFT JOIN sessions s ON s.session_id = t.session_id
        WHERE t.timestamp IS NOT NULL AND {day} >= date('now', ?)
        GROUP BY project
        ORDER BY weighted DESC
    '''
    return _rows(conn, sql, (f'-{days} days',))


def cost_curve(conn: sqlite3.Connection, session_id: str, *, block: int = 25) -> list[dict[str, Any]]:
    """Cost per turn against context size, in blocks of *block* turns.

    This is the chart that makes a runaway session obvious: as the context
    grows, the weighted cost of every turn climbs with it, and a compaction
    shows up as a cliff back down to the floor.
    """
    sql = f'''
        WITH ordered AS (
            SELECT ROW_NUMBER() OVER (ORDER BY t.timestamp, t.id) - 1 AS n,
                   t.timestamp AS ts,
                   {_WEIGHTED} AS weighted,
                   {_CONTEXT}  AS context
            FROM turns t
            WHERE t.session_id = ?
        )
        SELECT (n / ?) * ?                     AS turn_from,
               MIN(ts)                         AS ts,
               COUNT(*)                        AS turns,
               CAST(SUM(weighted) AS INTEGER)  AS weighted,
               CAST(AVG(weighted) AS INTEGER)  AS weighted_per_turn,
               CAST(AVG(context)  AS INTEGER)  AS context_avg
        FROM ordered
        GROUP BY n / ?
        ORDER BY turn_from
    '''
    return _rows(conn, sql, (session_id, block, block, block))


def quota_window(
    conn: sqlite3.Connection,
    *,
    hours: float,
    resets_at: float,
    limit: int = 20,
) -> list[dict[str, Any]]:
    """Which sessions fed the quota window that ends at *resets_at*.

    The app knows the real percentage of a window, because the API reports it,
    but not what spent it.  The transcripts know what ran and when, but not the
    percentage.  Intersecting the two answers the one question neither source
    answers alone: what ate my week?  *resets_at* is a Unix timestamp and the
    window is the *hours* preceding it.
    """
    # Both sides go through datetime(): the transcripts store
    # "2026-09-21T12:00:00Z" while 'unixepoch' yields "2026-09-21 12:00:00",
    # and comparing those two spellings as strings puts every timestamp above
    # the upper bound - the "T" sorts after the space.
    end_iso = f"datetime({resets_at}, 'unixepoch')"
    start_iso = f"datetime({resets_at} - {hours * 3600}, 'unixepoch')"
    sql = f'''
        SELECT t.session_id                      AS session_id,
               COALESCE(s.project_name, '?')     AS project,
               s.topic                           AS topic,
               COUNT(*)                          AS turns,
               SUM(t.is_subagent)                AS sub_turns,
               CAST(SUM({_WEIGHTED}) AS INTEGER) AS weighted,
               CAST(SUM({_RAW}) AS INTEGER)      AS raw,
               MIN(t.timestamp)                  AS first_ts,
               MAX(t.timestamp)                  AS last_ts
        FROM turns t
        LEFT JOIN sessions s ON s.session_id = t.session_id
        WHERE datetime(t.timestamp) >= {start_iso} AND datetime(t.timestamp) < {end_iso}
        GROUP BY t.session_id
        ORDER BY weighted DESC
        LIMIT ?
    '''
    return _rows(conn, sql, (limit,))

/* Session panel.
 *
 * Talks to Python over the pywebview bridge (`pywebview.api`, defined by
 * _PanelApi in panel.py).  Every call is async, and the first one can be slow
 * because it is what indexes the transcripts.
 *
 * Two things are remembered in the page rather than in Python: the theme and
 * the chart order.  Both are per-viewer preferences with no bearing on what the
 * app does, and localStorage keeps them out of the state file Python owns.
 */

'use strict';

var S = {};
var charts = {};
var sessionRows = [];
var sortKey = 'weighted';
var sortDesc = true;
var loaded = {};

var STORE_THEME = 'panel.theme';
var STORE_ORDER = 'panel.chartOrder';

var windowMode = { compact: false, on_top: false, opacity: 1 };

/* ---- formatting ---- */

function fmtTokens(n) {
    if (!n) { return '0'; }
    if (n >= 1e9) { return (n / 1e9).toFixed(2) + 'B'; }
    if (n >= 1e6) { return (n / 1e6).toFixed(2) + 'M'; }
    if (n >= 1e3) { return Math.round(n / 1e3) + 'k'; }
    return String(n);
}

function fmtWhen(iso) {
    return iso ? iso.replace('T', ' ').slice(5, 16) : '';
}

function fmtDuration(seconds) {
    if (seconds <= 0) { return S.panel_now || 'now'; }
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    if (h >= 48) { return Math.floor(h / 24) + 'd ' + (h % 24) + 'h'; }
    return h > 0 ? h + 'h ' + m + 'm' : m + 'm';
}

function text(id, value) {
    var el = document.getElementById(id);
    if (el) { el.textContent = value; }
}

function status(message, kind) {
    var el = document.getElementById('status');
    el.textContent = message || '';
    el.className = 'status' + (kind ? ' ' + kind : '');
}

function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue('--' + name).trim();
}

/* ---- bridge ---- */

// The bridge object appears slightly after the page loads; calls made before
// then would throw, so they wait for it.
function api() {
    return new Promise(function (resolve) {
        (function wait() {
            if (window.pywebview && window.pywebview.api) { resolve(window.pywebview.api); }
            else { setTimeout(wait, 30); }
        }());
    });
}

function call(method) {
    var args = Array.prototype.slice.call(arguments, 1);
    return api().then(function (a) { return a[method].apply(a, args); });
}

/* ---- theme ---- */

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(STORE_THEME, theme); } catch (e) { /* private mode */ }
    // Chart.js bakes the colours in at construction, so every chart has to be
    // rebuilt against the new palette.
    Object.keys(charts).forEach(function (id) { charts[id].destroy(); });
    charts = {};
    if (!document.getElementById('panelCharts').hidden) { loadCharts(); }
    renderUsage();
}

function currentTheme() {
    return document.documentElement.getAttribute('data-theme') || 'dark';
}

/* ---- range ---- */

function tzOffset() { return -new Date().getTimezoneOffset(); }

function rangeBounds() {
    var days = parseInt(document.getElementById('range').value, 10);
    if (!days) { return [null, null, 3650]; }
    var until = new Date();
    var since = new Date(until.getTime() - days * 86400000);
    var iso = function (d) { return d.toISOString().slice(0, 10); };
    return [days === 1 ? iso(until) : iso(since), null, days];
}

/* ---- usage sidebar ---- */

var usageWindows = [];
var versions = [];

function quotaBar(w, big) {
    var box = document.createElement('div');
    box.className = 'quota';

    var head = document.createElement('div');
    head.className = 'quota-head';
    var left = document.createElement('div');
    var label = document.createElement('div');
    label.className = 'quota-label';
    label.textContent = w.label || w.field;
    var reset = document.createElement('div');
    reset.className = 'quota-reset';
    reset.textContent = w.reset_text || ((S.panel_resets_in || 'resets in') + ' ' + fmtDuration(w.resets_at - Date.now() / 1000));
    left.appendChild(label);
    left.appendChild(reset);
    var pct = document.createElement('span');
    pct.className = 'quota-pct';
    pct.textContent = Math.round(w.utilization) + '%';
    head.appendChild(left);
    head.appendChild(pct);
    box.appendChild(head);

    // Same three markings as the tray popup: the fill, the boundaries of the
    // period (hours on a 5h bar, days on a weekly one), and where the clock
    // currently is.  A bar is "warn" when usage is ahead of that clock, not at
    // a fixed percentage - that is the whole point of the marker.
    var bar = document.createElement('div');
    bar.className = 'quota-bar' + (w.warn ? ' warn' : '');

    var fill = document.createElement('span');
    fill.className = 'bar-fill';
    fill.style.width = Math.min(100, w.utilization) + '%';
    bar.appendChild(fill);

    (w.dividers || []).forEach(function (pos) {
        var d = document.createElement('i');
        d.className = 'bar-divider';
        d.style.left = (pos * 100) + '%';
        bar.appendChild(d);
    });

    if (w.marker_rel !== null && w.marker_rel !== undefined) {
        var marker = document.createElement('i');
        marker.className = 'bar-marker';
        marker.style.left = 'calc(' + (w.marker_rel * 100) + '% - 1px)';
        bar.appendChild(marker);
    }

    box.appendChild(bar);
    if (big) { box.dataset.big = '1'; }
    return box;
}

function renderUsage() {
    var host = document.getElementById('usageList');
    host.textContent = '';
    if (!usageWindows.length) {
        var p = document.createElement('p');
        p.className = 'dim';
        p.textContent = S.panel_no_quota || 'No quota window reported yet.';
        host.appendChild(p);
    } else {
        usageWindows.forEach(function (w) { host.appendChild(quotaBar(w, false)); });
    }

    var vhost = document.getElementById('versionList');
    vhost.textContent = '';
    versions.forEach(function (v) {
        var row = document.createElement('div');
        var name = document.createElement('span');
        name.textContent = v.name;
        var value = document.createElement('span');
        value.textContent = v.version;
        row.appendChild(name);
        row.appendChild(value);
        vhost.appendChild(row);
    });
}

function loadUsage() {
    return call('usage').then(function (data) {
        usageWindows = (data && data.windows) || [];
        versions = (data && data.versions) || [];
        renderUsage();
    }).catch(function () { /* the sidebar is not worth an error banner */ });
}

/* ---- sessions ---- */

function loadSessions() {
    var bounds = rangeBounds();
    status(S.panel_loading || 'Loading...', 'busy');
    return call('sessions', bounds[0], bounds[1], tzOffset(), 300).then(function (rows) {
        sessionRows = rows || [];
        renderSessions();
        fillCurvePicker();
        status('');
    }).catch(function (err) { status(String(err), 'error'); });
}

function renderSessions() {
    var tbody = document.querySelector('#sessionsTable tbody');
    var empty = document.getElementById('sessionsEmpty');
    tbody.textContent = '';

    if (!sessionRows.length) {
        empty.textContent = S.panel_no_data || 'Nothing indexed for this range.';
        empty.hidden = false;
        return;
    }
    empty.hidden = true;

    var rows = sessionRows.slice().sort(function (a, b) {
        var x = a[sortKey], y = b[sortKey];
        if (typeof x === 'string' || typeof y === 'string') {
            x = String(x || ''); y = String(y || '');
            return sortDesc ? y.localeCompare(x) : x.localeCompare(y);
        }
        return sortDesc ? (y || 0) - (x || 0) : (x || 0) - (y || 0);
    });

    var max = rows.reduce(function (m, r) { return Math.max(m, r.weighted || 0); }, 0) || 1;

    rows.forEach(function (r) {
        var tr = document.createElement('tr');
        tr.dataset.sessionId = r.session_id;
        [
            ['num bar-cell', fmtTokens(r.weighted), (100 * (r.weighted || 0) / max) + '%'],
            ['num', fmtTokens(r.raw)],
            ['num', String(r.turns || 0)],
            ['num', fmtTokens(r.ctx_avg)],
            ['num', fmtTokens(r.ctx_peak)],
            ['num', r.sub_weighted ? fmtTokens(r.sub_weighted) : '-'],
            ['', fmtWhen(r.first_ts)],
            ['', r.project || '?'],
            ['topic', r.topic || '']
        ].forEach(function (c) {
            var td = document.createElement('td');
            td.className = c[0];
            td.textContent = c[1];
            if (c[2]) { td.style.setProperty('--share', c[2]); }
            tr.appendChild(td);
        });
        tr.addEventListener('click', function () { selectSession(r.session_id); });
        tbody.appendChild(tr);
    });
}

function selectSession(sessionId) {
    Array.prototype.forEach.call(document.querySelectorAll('#sessionsTable tbody tr'), function (tr) {
        tr.classList.toggle('selected', tr.dataset.sessionId === sessionId);
    });
    document.getElementById('curveSession').value = sessionId;
    loadCurve(sessionId);
}

/* ---- charts ---- */

var PALETTE = ['#4f8cc9', '#c98b4f', '#7bb26e', '#b06ec9', '#c95f5f', '#4fb3c9', '#9a9a9a'];

function baseOptions(extra) {
    var grid = { color: cssVar('grid') };
    var ticks = { color: cssVar('fg-dim') };
    return Object.assign({
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { labels: { color: cssVar('fg-dim'), boxWidth: 10, boxHeight: 10 } } },
        scales: { x: { grid: grid, ticks: ticks }, y: { grid: grid, ticks: ticks, beginAtZero: true } }
    }, extra || {});
}

function draw(id, config) {
    if (charts[id]) { charts[id].destroy(); }
    charts[id] = new Chart(document.getElementById(id).getContext('2d'), config);
}

function loadCharts() {
    var days = rangeBounds()[2];
    status(S.panel_loading || 'Loading...', 'busy');
    return call('charts', days, tzOffset()).then(function (data) {
        drawDaily(data.by_model, data.daily);
        drawHourly(data.hourly);
        drawProjects(data.by_project);
        var picker = document.getElementById('curveSession');
        if (picker.value) { loadCurve(picker.value); }
        status('');
    }).catch(function (err) { status(String(err), 'error'); });
}

function tokenAxis() {
    return { beginAtZero: true, grid: { color: cssVar('grid') }, ticks: { color: cssVar('fg-dim'), callback: fmtTokens } };
}

function drawDaily(byModel, daily) {
    var days = [], models = [], cell = {};
    (byModel || []).forEach(function (r) {
        if (days.indexOf(r.day) === -1) { days.push(r.day); }
        var model = (r.model || '?').replace(/^claude-/, '');
        if (models.indexOf(model) === -1) { models.push(model); }
        cell[r.day + '|' + model] = r.weighted;
    });
    days.sort();

    if (!models.length) {
        days = (daily || []).map(function (d) { return d.day; }).sort();
        models = [S.panel_total || 'total'];
        (daily || []).forEach(function (d) { cell[d.day + '|' + models[0]] = d.weighted; });
    }

    draw('chartDaily', {
        type: 'bar',
        data: {
            labels: days.map(function (d) { return d.slice(5); }),
            datasets: models.map(function (m, i) {
                return {
                    label: m,
                    data: days.map(function (d) { return cell[d + '|' + m] || 0; }),
                    backgroundColor: PALETTE[i % PALETTE.length]
                };
            })
        },
        options: baseOptions({
            scales: {
                x: { stacked: true, grid: { display: false }, ticks: { color: cssVar('fg-dim') } },
                y: Object.assign({ stacked: true }, tokenAxis())
            }
        })
    });
}

function drawHourly(hourly) {
    var byHour = new Array(24).fill(0);
    (hourly || []).forEach(function (r) { byHour[r.hour] = r.weighted; });
    draw('chartHourly', {
        type: 'bar',
        data: {
            labels: byHour.map(function (_, h) { return String(h).padStart(2, '0'); }),
            datasets: [{ label: S.panel_weighted || 'weighted', data: byHour, backgroundColor: cssVar('accent') }]
        },
        options: baseOptions({
            plugins: { legend: { display: false } },
            scales: { x: { grid: { display: false }, ticks: { color: cssVar('fg-dim') } }, y: tokenAxis() }
        })
    });
}

function drawProjects(projects) {
    var top = (projects || []).slice(0, 10);
    draw('chartProject', {
        type: 'bar',
        data: {
            labels: top.map(function (p) { return p.project; }),
            datasets: [{ label: S.panel_weighted || 'weighted', data: top.map(function (p) { return p.weighted; }), backgroundColor: cssVar('accent') }]
        },
        options: baseOptions({
            indexAxis: 'y',
            plugins: { legend: { display: false } },
            scales: { x: tokenAxis(), y: { grid: { display: false }, ticks: { color: cssVar('fg-dim') } } }
        })
    });
}

function fillCurvePicker() {
    var picker = document.getElementById('curveSession');
    var current = picker.value;
    picker.textContent = '';
    sessionRows.slice(0, 40).forEach(function (r) {
        var opt = document.createElement('option');
        opt.value = r.session_id;
        opt.textContent = fmtTokens(r.weighted) + ' - ' + (r.project || '?') + ' - ' + (r.topic || r.session_id.slice(0, 8));
        picker.appendChild(opt);
    });
    if (sessionRows.length) {
        var keep = current && sessionRows.some(function (r) { return r.session_id === current; });
        picker.value = keep ? current : sessionRows[0].session_id;
        loadCurve(picker.value);
    }
}

// Cost per turn (bars) against context size (line).  They climb together, and
// a compaction drops both.
function loadCurve(sessionId) {
    if (!sessionId) { return Promise.resolve(); }
    return call('cost_curve', sessionId, 25).then(function (blocks) {
        draw('chartCurve', {
            data: {
                labels: (blocks || []).map(function (b) { return b.turn_from; }),
                datasets: [
                    {
                        type: 'bar',
                        label: S.panel_per_turn || 'weighted / turn',
                        data: (blocks || []).map(function (b) { return b.weighted_per_turn; }),
                        backgroundColor: cssVar('accent'),
                        yAxisID: 'y'
                    },
                    {
                        type: 'line',
                        label: S.panel_context || 'context',
                        data: (blocks || []).map(function (b) { return b.context_avg; }),
                        borderColor: cssVar('warn'),
                        backgroundColor: cssVar('warn'),
                        pointRadius: 2,
                        tension: 0.25,
                        yAxisID: 'y1'
                    }
                ]
            },
            options: baseOptions({
                scales: {
                    x: { grid: { display: false }, ticks: { color: cssVar('fg-dim') } },
                    y: Object.assign({ position: 'left' }, tokenAxis()),
                    y1: { beginAtZero: true, position: 'right', grid: { display: false }, ticks: { color: cssVar('fg-dim'), callback: fmtTokens } }
                }
            })
        });
    }).catch(function (err) { status(String(err), 'error'); });
}

/* ---- chart reordering ---- */

function chartOrder() {
    try { return JSON.parse(localStorage.getItem(STORE_ORDER)) || []; } catch (e) { return []; }
}

function saveChartOrder() {
    var order = Array.prototype.map.call(document.querySelectorAll('#chartGrid .card'), function (c) {
        return c.dataset.chart;
    });
    try { localStorage.setItem(STORE_ORDER, JSON.stringify(order)); } catch (e) { /* private mode */ }
}

function restoreChartOrder() {
    var grid = document.getElementById('chartGrid');
    chartOrder().forEach(function (key) {
        var card = grid.querySelector('.card[data-chart="' + key + '"]');
        if (card) { grid.appendChild(card); }
    });
}

function wireChartDrag() {
    var grid = document.getElementById('chartGrid');
    var dragged = null;

    Array.prototype.forEach.call(grid.querySelectorAll('.card'), function (card) {
        card.addEventListener('dragstart', function (e) {
            dragged = card;
            card.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            // Firefox refuses to start a drag without payload.
            e.dataTransfer.setData('text/plain', card.dataset.chart);
        });

        card.addEventListener('dragend', function () {
            card.classList.remove('dragging');
            Array.prototype.forEach.call(grid.querySelectorAll('.card'), function (c) {
                c.classList.remove('drop-target');
            });
            dragged = null;
            saveChartOrder();
        });

        card.addEventListener('dragover', function (e) {
            if (!dragged || dragged === card) { return; }
            e.preventDefault();
            card.classList.add('drop-target');
        });

        card.addEventListener('dragleave', function () { card.classList.remove('drop-target'); });

        card.addEventListener('drop', function (e) {
            if (!dragged || dragged === card) { return; }
            e.preventDefault();
            card.classList.remove('drop-target');
            // Insert before or after depending on which way the card travelled,
            // so a card dragged downwards lands below its target.
            var cards = Array.prototype.slice.call(grid.querySelectorAll('.card'));
            var moveDown = cards.indexOf(dragged) < cards.indexOf(card);
            grid.insertBefore(dragged, moveDown ? card.nextSibling : card);
            saveChartOrder();
        });
    });
}

/* ---- insights ---- */

function loadInsights() {
    var days = rangeBounds()[2];
    status(S.panel_loading || 'Loading...', 'busy');
    return call('insights', days, tzOffset()).then(function (data) {
        renderInsights(data || {});
        status('');
    }).catch(function (err) { status(String(err), 'error'); });
}

function renderInsights(data) {
    var traits = document.getElementById('insightTraits');
    var tables = document.getElementById('insightTables');
    traits.textContent = '';
    tables.textContent = '';

    if (!data.total) {
        var p = document.createElement('p');
        p.className = 'empty';
        p.textContent = S.panel_no_data || 'Nothing indexed for this range.';
        traits.appendChild(p);
        return;
    }

    [
        ['big_context', S.panel_trait_context, S.panel_advice_context],
        ['subagent_heavy', S.panel_trait_subagents, S.panel_advice_subagents],
        ['long_running', S.panel_trait_long, S.panel_advice_long]
    ].forEach(function (t) {
        if (!data[t[0]]) { return; }
        var box = document.createElement('div');
        box.className = 'trait';
        var head = document.createElement('div');
        var pct = document.createElement('span');
        pct.className = 'trait-pct';
        pct.textContent = data[t[0]] + '%';
        var title = document.createElement('span');
        title.className = 'trait-title';
        title.textContent = t[1] || '';
        head.appendChild(pct);
        head.appendChild(title);
        var advice = document.createElement('div');
        advice.className = 'trait-advice';
        advice.textContent = t[2] || '';
        box.appendChild(head);
        box.appendChild(advice);
        traits.appendChild(box);
    });

    [
        ['skills', S.panel_tbl_skills],
        ['subagents', S.panel_tbl_subagents],
        ['mcp', S.panel_tbl_mcp]
    ].forEach(function (t) {
        var rows = data[t[0]] || [];
        if (!rows.length) { return; }
        var card = document.createElement('figure');
        card.className = 'card';
        var cap = document.createElement('figcaption');
        cap.textContent = t[1] || t[0];
        card.appendChild(cap);
        var table = document.createElement('table');
        var tbody = document.createElement('tbody');
        rows.forEach(function (r) {
            var tr = document.createElement('tr');
            var name = document.createElement('td');
            name.textContent = r.name;
            var pct = document.createElement('td');
            pct.className = 'num';
            pct.textContent = r.percent + '%';
            tr.appendChild(name);
            tr.appendChild(pct);
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        card.appendChild(table);
        tables.appendChild(card);
    });
}

/* ---- quotas tab ---- */

function loadQuotas() {
    status(S.panel_loading || 'Loading...', 'busy');
    return call('quotas').then(function (windows) {
        var host = document.getElementById('quotaList');
        host.textContent = '';
        if (!windows || !windows.length) {
            var p = document.createElement('p');
            p.className = 'empty';
            p.textContent = S.panel_no_quota || 'No quota window reported yet.';
            host.appendChild(p);
            return;
        }
        windows.forEach(function (w) { host.appendChild(renderQuotaDetail(w)); });
        status('');
    }).catch(function (err) { status(String(err), 'error'); });
}

function renderQuotaDetail(w) {
    var box = quotaBar(w, true);
    var rows = w.sessions || [];

    if (!rows.length) {
        var none = document.createElement('p');
        none.className = 'hint';
        none.textContent = S.panel_no_attribution || 'No local transcripts cover this window.';
        box.appendChild(none);
        return box;
    }

    var total = rows.reduce(function (sum, r) { return sum + (r.weighted || 0); }, 0) || 1;
    var table = document.createElement('table');
    var tbody = document.createElement('tbody');

    rows.forEach(function (r) {
        var tr = document.createElement('tr');
        [
            ['num', Math.round(100 * (r.weighted || 0) / total) + '%'],
            ['num', fmtTokens(r.weighted)],
            ['num', String(r.turns || 0)],
            ['', r.project || '?'],
            ['topic', r.topic || r.session_id.slice(0, 8)]
        ].forEach(function (c) {
            var td = document.createElement('td');
            td.className = c[0];
            td.textContent = c[1];
            tr.appendChild(td);
        });
        if (r.sub_turns) {
            var tag = document.createElement('span');
            tag.className = 'sub-tag';
            tag.textContent = (S.panel_subagents || 'sub') + ' ' + r.sub_turns;
            tr.lastChild.appendChild(tag);
        }
        tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    box.appendChild(table);
    return box;
}

/* ---- tabs and wiring ---- */

var loaders = { sessions: loadSessions, charts: loadCharts, insights: loadInsights, quotas: loadQuotas };

function showTab(name) {
    ['sessions', 'charts', 'insights', 'quotas'].forEach(function (t) {
        document.getElementById('panel' + t[0].toUpperCase() + t.slice(1)).hidden = (t !== name);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
        b.classList.toggle('active', b.dataset.tab === name);
    });
    if (!loaded[name]) {
        loaded[name] = true;
        loaders[name]();
    }
    // Chart.js measures a hidden canvas as 0x0; re-measure once it is visible.
    if (name === 'charts') {
        Object.keys(charts).forEach(function (id) { charts[id].resize(); });
    }
}

var geometryTimer = null;
function reportGeometry() {
    call('report_geometry', window.outerWidth || window.innerWidth,
         window.outerHeight || window.innerHeight, window.screenX, window.screenY);
}

function refreshAll() {
    status(S.panel_indexing || 'Indexing...', 'busy');
    return call('refresh', 0).then(function (result) {
        if (result && result.error) { status(result.error, 'error'); return; }
        loaded = {};
        loadUsage();
        var active = document.querySelector('.tab.active').dataset.tab;
        loaded[active] = true;
        return loaders[active]().then(function () {
            if (result && result.elapsed > 0.05) {
                status((S.panel_indexed_in || 'indexed in') + ' ' + result.elapsed.toFixed(1) + 's');
            }
        });
    }).catch(function (err) { status(String(err), 'error'); });
}

function applyWindowMode() {
    document.body.classList.toggle('compact', windowMode.compact);
    document.getElementById('compactBtn').textContent = windowMode.compact ? '»' : '«';
    document.getElementById('compactBtn').title = windowMode.compact
        ? (S.panel_expand || 'Expand') : (S.panel_collapse || 'Collapse');
    document.getElementById('floatBtn').classList.toggle('on', windowMode.on_top);
    document.getElementById('opacity').value = String(Math.round(windowMode.opacity * 100));
    return call('set_window_mode', windowMode.compact, windowMode.on_top, windowMode.opacity);
}

function init(config) {
    S = config.strings || {};
    windowMode = {
        compact: !!config.compact,
        on_top: !!config.on_top,
        opacity: typeof config.opacity === 'number' ? config.opacity : 1
    };

    var stored = null;
    try { stored = localStorage.getItem(STORE_THEME); } catch (e) { /* private mode */ }
    document.documentElement.setAttribute('data-theme', stored || config.theme || 'dark');

    text('tabSessions', S.panel_tab_sessions || 'Sessions');
    text('tabCharts', S.panel_tab_charts || 'Charts');
    text('tabInsights', S.panel_tab_insights || 'Usage');
    text('tabQuotas', S.panel_tab_quotas || 'Quotas');
    text('refreshBtn', S.panel_refresh || 'Refresh');
    text('usageHeading', S.panel_usage_heading || 'Usage');
    text('thWeighted', S.panel_col_weighted || 'Weighted');
    text('thRaw', S.panel_col_raw || 'Raw');
    text('thTurns', S.panel_col_turns || 'Turns');
    text('thCtxAvg', S.panel_col_ctx_avg || 'Ctx avg');
    text('thCtxPeak', S.panel_col_ctx_peak || 'Ctx peak');
    text('thSub', S.panel_col_sub || 'Subagents');
    text('thWhen', S.panel_col_when || 'Started');
    text('thProject', S.panel_col_project || 'Project');
    text('thTopic', S.panel_col_topic || 'Topic');
    text('capDaily', S.panel_cap_daily || 'Daily usage by model');
    text('capHourly', S.panel_cap_hourly || 'By hour of day');
    text('capProject', S.panel_cap_project || 'By project');
    text('capCurve', S.panel_cap_curve || 'Cost per turn vs context');
    text('hintCurve', S.panel_hint_curve || '');
    text('hintQuota', S.panel_hint_quota || '');
    text('hintDrag', S.panel_hint_drag || '');
    text('hintInsights', S.panel_hint_insights || '');
    text('footVersion', 'v' + (config.version || ''));
    text('footWeights', S.panel_weights_note || '');

    var range = document.getElementById('range');
    [[1, S.panel_range_today || 'Today'], [7, S.panel_range_7 || '7 days'],
     [30, S.panel_range_30 || '30 days'], [0, S.panel_range_all || 'All']].forEach(function (o) {
        var opt = document.createElement('option');
        opt.value = o[0];
        opt.textContent = o[1];
        range.appendChild(opt);
    });
    range.value = '7';

    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
        b.addEventListener('click', function () { showTab(b.dataset.tab); });
    });

    Array.prototype.forEach.call(document.querySelectorAll('th[data-sort]'), function (th) {
        th.addEventListener('click', function () {
            sortDesc = (th.dataset.sort === sortKey) ? !sortDesc : true;
            sortKey = th.dataset.sort;
            Array.prototype.forEach.call(document.querySelectorAll('th[data-sort]'), function (o) {
                o.classList.toggle('sorted', o === th);
            });
            renderSessions();
        });
    });

    range.addEventListener('change', function () {
        loaded = {};
        showTab(document.querySelector('.tab.active').dataset.tab);
    });

    document.getElementById('refreshBtn').addEventListener('click', refreshAll);
    document.getElementById('compactBtn').addEventListener('click', function () {
        windowMode.compact = !windowMode.compact;
        applyWindowMode();
    });
    document.getElementById('floatBtn').addEventListener('click', function () {
        windowMode.on_top = !windowMode.on_top;
        applyWindowMode();
    });
    document.getElementById('opacity').addEventListener('input', function (e) {
        windowMode.opacity = Math.max(0.25, Math.min(1, parseInt(e.target.value, 10) / 100));
        applyWindowMode();
    });

    document.body.classList.toggle('compact', windowMode.compact);
    applyWindowMode();
    document.getElementById('themeBtn').addEventListener('click', function () {
        applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
    });
    document.getElementById('curveSession').addEventListener('change', function (e) {
        loadCurve(e.target.value);
    });

    restoreChartOrder();
    wireChartDrag();

    window.addEventListener('resize', function () {
        clearTimeout(geometryTimer);
        geometryTimer = setTimeout(reportGeometry, 400);
    });
    setInterval(reportGeometry, 5000);
    setInterval(loadUsage, 60000);

    loadUsage();

    if (windowMode.compact) {
        showTab('sessions');
        return;
    }

    if (config.indexed) {
        showTab('sessions');
    } else {
        status(S.panel_first_index || 'Building the index, this only happens once...', 'busy');
        call('refresh', 0).then(function () { showTab('sessions'); });
    }
}

window.init = init;

/* Session panel.
 *
 * Talks to Python over the pywebview bridge (`pywebview.api`, defined by
 * _PanelApi in panel.py).  Every call is async and every one of them can be
 * slow the first time, because the first call is what indexes the transcripts.
 */

'use strict';

var S = {};            // localised strings, from Python
var COLORS = {};
var charts = {};       // canvas id -> Chart instance
var sessionRows = [];
var sortKey = 'weighted';
var sortDesc = true;

/* ---- formatting ---- */

function fmtTokens(n) {
    if (!n) { return '0'; }
    if (n >= 1e9) { return (n / 1e9).toFixed(2) + 'B'; }
    if (n >= 1e6) { return (n / 1e6).toFixed(2) + 'M'; }
    if (n >= 1e3) { return Math.round(n / 1e3) + 'k'; }
    return String(n);
}

function fmtWhen(iso) {
    if (!iso) { return ''; }
    return iso.replace('T', ' ').slice(5, 16);
}

function fmtDuration(seconds) {
    if (seconds <= 0) { return S.panel_now || 'now'; }
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    if (h >= 48) { return Math.floor(h / 24) + 'd ' + (h % 24) + 'h'; }
    if (h > 0) { return h + 'h ' + m + 'm'; }
    return m + 'm';
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

/* ---- bridge ---- */

// The bridge object appears slightly after the page loads; calls made in
// between would throw, so they wait for it instead.
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

/* ---- range ---- */

function tzOffset() {
    return -new Date().getTimezoneOffset();
}

function rangeValue() {
    return document.getElementById('range').value;
}

// Returns [since, until, days] as local-time date strings for the SQL filter.
function rangeBounds() {
    var days = parseInt(rangeValue(), 10);
    if (!days) { return [null, null, 3650]; }
    var until = new Date();
    var since = new Date(until.getTime() - days * 86400000);
    var iso = function (d) { return d.toISOString().slice(0, 10); };
    return [days === 1 ? iso(until) : iso(since), null, days];
}

/* ---- sessions tab ---- */

function loadSessions() {
    var bounds = rangeBounds();
    status(S.panel_loading || 'Loading...', 'busy');
    return call('sessions', bounds[0], bounds[1], tzOffset(), 300).then(function (rows) {
        sessionRows = rows || [];
        renderSessions();
        fillCurvePicker();
        status('');
    }).catch(function (err) {
        status(String(err), 'error');
    });
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

        var cells = [
            ['num bar-cell', fmtTokens(r.weighted), (100 * (r.weighted || 0) / max) + '%'],
            ['num', fmtTokens(r.raw)],
            ['num', String(r.turns || 0)],
            ['num', fmtTokens(r.ctx_avg)],
            ['num', fmtTokens(r.ctx_peak)],
            ['num', r.sub_weighted ? fmtTokens(r.sub_weighted) : '-'],
            ['', fmtWhen(r.first_ts)],
            ['', r.project || '?'],
            ['topic', r.topic || '']
        ];

        cells.forEach(function (c) {
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
    var picker = document.getElementById('curveSession');
    picker.value = sessionId;
    loadCurve(sessionId);
}

/* ---- charts tab ---- */

function baseOptions(extra) {
    var grid = { color: 'rgba(255,255,255,0.07)' };
    var ticks = { color: COLORS.fg_dim || '#9a9a9a' };
    var options = {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
            legend: { labels: { color: COLORS.fg_dim, boxWidth: 10, boxHeight: 10 } },
            tooltip: { callbacks: {} }
        },
        scales: {
            x: { grid: grid, ticks: ticks },
            y: { grid: grid, ticks: ticks, beginAtZero: true }
        }
    };
    return Object.assign(options, extra || {});
}

function draw(id, config) {
    if (charts[id]) { charts[id].destroy(); }
    charts[id] = new Chart(document.getElementById(id).getContext('2d'), config);
}

// Distinct hues per model, assigned in first-seen order so the palette stays
// stable while a session list is being filtered.
var PALETTE = ['#4f8cc9', '#c98b4f', '#7bb26e', '#b06ec9', '#c95f5f', '#4fb3c9', '#9a9a9a'];

function loadCharts() {
    var days = rangeBounds()[2];
    status(S.panel_loading || 'Loading...', 'busy');
    return call('charts', days, tzOffset()).then(function (data) {
        drawDaily(data.by_model, data.daily);
        drawHourly(data.hourly);
        drawProjects(data.by_project);
        status('');
    }).catch(function (err) {
        status(String(err), 'error');
    });
}

function drawDaily(byModel, daily) {
    var days = [];
    var models = [];
    var cell = {};

    (byModel || []).forEach(function (r) {
        if (days.indexOf(r.day) === -1) { days.push(r.day); }
        var model = (r.model || '?').replace(/^claude-/, '');
        if (models.indexOf(model) === -1) { models.push(model); }
        cell[r.day + '|' + model] = r.weighted;
    });
    days.sort();

    // Fall back to the undifferentiated totals when no per-model rows exist.
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
                x: { stacked: true, grid: { display: false }, ticks: { color: COLORS.fg_dim } },
                y: {
                    stacked: true, beginAtZero: true,
                    grid: { color: 'rgba(255,255,255,0.07)' },
                    ticks: { color: COLORS.fg_dim, callback: fmtTokens }
                }
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
            datasets: [{ label: S.panel_weighted || 'weighted', data: byHour, backgroundColor: COLORS.accent }]
        },
        options: baseOptions({
            plugins: { legend: { display: false } },
            scales: {
                x: { grid: { display: false }, ticks: { color: COLORS.fg_dim } },
                y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.07)' }, ticks: { color: COLORS.fg_dim, callback: fmtTokens } }
            }
        })
    });
}

function drawProjects(projects) {
    var top = (projects || []).slice(0, 10);
    draw('chartProject', {
        type: 'bar',
        data: {
            labels: top.map(function (p) { return p.project; }),
            datasets: [{ label: S.panel_weighted || 'weighted', data: top.map(function (p) { return p.weighted; }), backgroundColor: COLORS.accent }]
        },
        options: baseOptions({
            indexAxis: 'y',
            plugins: { legend: { display: false } },
            scales: {
                x: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.07)' }, ticks: { color: COLORS.fg_dim, callback: fmtTokens } },
                y: { grid: { display: false }, ticks: { color: COLORS.fg_dim } }
            }
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
        picker.value = current && sessionRows.some(function (r) { return r.session_id === current; })
            ? current : sessionRows[0].session_id;
        loadCurve(picker.value);
    }
}

// The point of this chart: cost per turn (bars) rising with context size
// (line).  A compaction shows up as both dropping together.
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
                        backgroundColor: COLORS.accent,
                        yAxisID: 'y'
                    },
                    {
                        type: 'line',
                        label: S.panel_context || 'context',
                        data: (blocks || []).map(function (b) { return b.context_avg; }),
                        borderColor: COLORS.warn,
                        backgroundColor: COLORS.warn,
                        pointRadius: 2,
                        tension: 0.25,
                        yAxisID: 'y1'
                    }
                ]
            },
            options: baseOptions({
                scales: {
                    x: { grid: { display: false }, ticks: { color: COLORS.fg_dim } },
                    y: {
                        beginAtZero: true, position: 'left',
                        grid: { color: 'rgba(255,255,255,0.07)' },
                        ticks: { color: COLORS.fg_dim, callback: fmtTokens }
                    },
                    y1: {
                        beginAtZero: true, position: 'right',
                        grid: { display: false },
                        ticks: { color: COLORS.fg_dim, callback: fmtTokens }
                    }
                }
            })
        });
    }).catch(function (err) { status(String(err), 'error'); });
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

        windows.forEach(function (w) { host.appendChild(renderQuota(w)); });
        status('');
    }).catch(function (err) { status(String(err), 'error'); });
}

function renderQuota(w) {
    var box = document.createElement('div');
    box.className = 'quota';

    var head = document.createElement('div');
    head.className = 'quota-head';
    var left = document.createElement('div');
    left.innerHTML = '<span class="quota-label"></span> <span class="quota-reset"></span>';
    left.querySelector('.quota-label').textContent = w.label || w.field;
    left.querySelector('.quota-reset').textContent =
        (S.panel_resets_in || 'resets in') + ' ' + fmtDuration(w.resets_at - Date.now() / 1000);
    var pct = document.createElement('span');
    pct.className = 'quota-pct';
    pct.textContent = Math.round(w.utilization) + '%';
    head.appendChild(left);
    head.appendChild(pct);
    box.appendChild(head);

    var bar = document.createElement('div');
    bar.className = 'quota-bar' + (w.utilization >= 80 ? ' warn' : '');
    var fill = document.createElement('span');
    fill.style.width = Math.min(100, w.utilization) + '%';
    bar.appendChild(fill);
    box.appendChild(bar);

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

/* ---- tabs, geometry, wiring ---- */

var loaders = { sessions: loadSessions, charts: loadCharts, quotas: loadQuotas };
var loaded = {};

function showTab(name) {
    ['sessions', 'charts', 'quotas'].forEach(function (t) {
        document.getElementById('panel' + t[0].toUpperCase() + t.slice(1)).hidden = (t !== name);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
        b.classList.toggle('active', b.dataset.tab === name);
    });
    if (!loaded[name]) {
        loaded[name] = true;
        loaders[name]();
    }
    // Chart.js sizes to a hidden canvas as 0x0; re-measure once it is visible.
    if (name === 'charts') {
        Object.keys(charts).forEach(function (id) { charts[id].resize(); });
    }
}

function reportGeometry() {
    call('report_geometry', window.outerWidth || window.innerWidth,
         window.outerHeight || window.innerHeight,
         window.screenX, window.screenY);
}

var geometryTimer = null;
function scheduleGeometry() {
    clearTimeout(geometryTimer);
    geometryTimer = setTimeout(reportGeometry, 400);
}

function refreshAll() {
    status(S.panel_indexing || 'Indexing...', 'busy');
    return call('refresh', 0).then(function (result) {
        if (result && result.error) {
            status(result.error, 'error');
            return;
        }
        loaded = {};
        var active = document.querySelector('.tab.active').dataset.tab;
        loaded[active] = true;
        return loaders[active]().then(function () {
            if (result && typeof result.elapsed === 'number' && result.elapsed > 0.05) {
                status((S.panel_indexed_in || 'indexed in') + ' ' + result.elapsed.toFixed(1) + 's');
            }
        });
    }).catch(function (err) { status(String(err), 'error'); });
}

// Called from Python once the window is up.
function init(config) {
    S = config.strings || {};
    COLORS = config.colors || {};

    Object.keys(COLORS).forEach(function (key) {
        document.documentElement.style.setProperty('--' + key.replace(/_/g, '-'), COLORS[key]);
    });

    text('tabSessions', S.panel_tab_sessions || 'Sessions');
    text('tabCharts', S.panel_tab_charts || 'Charts');
    text('tabQuotas', S.panel_tab_quotas || 'Quotas');
    text('refreshBtn', S.panel_refresh || 'Refresh');
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
            var key = th.dataset.sort;
            sortDesc = (key === sortKey) ? !sortDesc : true;
            sortKey = key;
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
    document.getElementById('curveSession').addEventListener('change', function (e) {
        loadCurve(e.target.value);
    });

    window.addEventListener('resize', scheduleGeometry);
    setInterval(reportGeometry, 5000);

    // A first run has no index yet, so build it before the first query rather
    // than showing an empty table.
    if (config.indexed) {
        showTab('sessions');
    } else {
        status(S.panel_first_index || 'Building the index, this only happens once...', 'busy');
        call('refresh', 0).then(function () { showTab('sessions'); });
    }
}

window.init = init;

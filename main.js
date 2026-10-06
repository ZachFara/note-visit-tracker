const { Plugin, ItemView, PluginSettingTab, Setting, Notice, TFile, getAllTags } = require("obsidian");

const VIEW_TYPE = "note-visit-tracker-view";

const TICK_SECONDS = 15;
const TICK_MS = TICK_SECONDS * 1000;
const ACTIVITY_EVENTS = ["mousemove", "mousedown", "keydown", "scroll", "wheel", "touchstart"];

const DEFAULT_SETTINGS = {
	excludeFolders: [],
	trackNonMarkdown: false,
	defaultRangeDays: 30,
	minVisits: 0,
	visitCooldownMinutes: 5,
	idleThresholdMinutes: 3,
	trendMetric: "opens",
	trendDisplay: "delta",
	legacyLogPath: "6 - Other/6.13 - Hidden Folders/Note Open Tracker/.note-open-events.ndjson",
	legacyImported: false,
};

function dateKey(d) {
	return (d || new Date()).toLocaleDateString("en-CA");
}

function addDays(d, n) {
	const copy = new Date(d);
	copy.setDate(copy.getDate() + n);
	return copy;
}

function formatDuration(totalSeconds) {
	const s = Math.round(totalSeconds || 0);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m ${sec}s`;
	return `${sec}s`;
}

// Every "YYYY-MM-DD" day key from startKey to endKey, inclusive.
function enumerateDayKeys(startKey, endKey) {
	const days = [];
	let d = new Date(startKey + "T00:00:00");
	const end = new Date(endKey + "T00:00:00");
	while (d <= end) {
		days.push(dateKey(d));
		d = addDays(d, 1);
	}
	return days;
}

// Collapses a long array down to at most maxBuckets, summing contiguous chunks,
// so a sparkline stays cheap to draw regardless of how wide the date range is.
function downsample(values, maxBuckets) {
	if (values.length <= maxBuckets) return values;
	const bucketSize = Math.ceil(values.length / maxBuckets);
	const buckets = [];
	for (let i = 0; i < values.length; i += bucketSize) {
		buckets.push(values.slice(i, i + bucketSize).reduce((a, b) => a + b, 0));
	}
	return buckets;
}

// `count` period ranges for the Trending tab, most recent first (index 0).
// "week" uses rolling 7-day blocks ending today, to sidestep ISO week-numbering.
// "month" uses real calendar months, with the current (possibly partial) month first,
// matching how the brainstorm example read ("Sep 2026: A, B, C / Aug 2026: D, A, E").
function getPeriodRanges(granularity, count) {
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	const ranges = [];

	if (granularity === "week") {
		for (let i = 0; i < count; i++) {
			const end = addDays(today, -7 * i);
			const start = addDays(end, -6);
			ranges.push({
				start: dateKey(start),
				end: dateKey(end),
				label: `${start.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${end.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`,
			});
		}
	} else {
		for (let i = 0; i < count; i++) {
			const monthDate = new Date(today.getFullYear(), today.getMonth() - i, 1);
			const monthStart = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
			const monthEnd = i === 0 ? today : new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0);
			ranges.push({
				start: dateKey(monthStart),
				end: dateKey(monthEnd),
				label: monthStart.toLocaleDateString(undefined, { month: "short", year: "numeric" }),
			});
		}
	}
	return ranges;
}

function movementSymbol(movement) {
	if (movement === "new") return "✦"; // ✦
	if (movement === "up") return "↑"; // ↑
	if (movement === "down") return "↓"; // ↓
	return "→"; // →
}

class NoteVisitTrackerPlugin extends Plugin {
	async onload() {
		const stored = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, stored && stored.settings);
		this.notes = (stored && stored.notes) || {};
		this._saveTimer = null;
		this.session = null;

		// Backfill entries saved by earlier versions of this plugin that predate the
		// active-duration fields, so tick()/handleRename() can assume they always exist.
		for (const entry of Object.values(this.notes)) {
			if (typeof entry.activeSeconds !== "number") entry.activeSeconds = 0;
			if (!entry.activeDaily) entry.activeDaily = {};
			if (!entry.daily) entry.daily = {};
		}

		this.registerView(VIEW_TYPE, (leaf) => new NoteVisitTrackerView(leaf, this));

		ACTIVITY_EVENTS.forEach((evt) => {
			this.registerDomEvent(document, evt, () => {
				if (this.session) this.session.lastActivity = Date.now();
			});
		});
		this.registerInterval(window.setInterval(() => this.tick(), TICK_MS));

		this.addRibbonIcon("trending-up", "Open Note Visit Tracker", () => this.activateView());

		this.addCommand({
			id: "open-note-visit-tracker",
			name: "Open Note Visit Tracker",
			callback: () => this.activateView(),
		});

		this.addCommand({
			id: "prune-missing-notes",
			name: "Prune tracker entries for notes that no longer exist",
			callback: () => this.pruneMissing(true),
		});

		this.addSettingTab(new NoteVisitTrackerSettingTab(this.app, this));

		// "file-open" fires when the active file changes, even within the same leaf
		// (e.g. clicking a wikilink). "active-leaf-change" fires when a different leaf
		// becomes active, including a non-file view (like this plugin's own tab) —
		// without it, switching to a non-file view wouldn't clear the active session,
		// since no file-open event fires for that. Both resolve the file from the
		// active leaf's view directly rather than workspace.getActiveFile(), which is
		// documented to keep returning the last-active markdown file even once a
		// non-file view (like this plugin's own tab) becomes active — exactly the case
		// that needs to clear the session.
		const onActiveChange = () => {
			const view = this.app.workspace.activeLeaf && this.app.workspace.activeLeaf.view;
			const file = view && view.file instanceof TFile ? view.file : null;
			this.onFileOpen(file);
		};
		this.registerEvent(this.app.workspace.on("file-open", onActiveChange));
		this.registerEvent(this.app.workspace.on("active-leaf-change", onActiveChange));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.handleRename(file, oldPath)));
		this.registerEvent(this.app.vault.on("delete", (file) => this.handleDelete(file)));
	}

	onunload() {
		if (this._saveTimer) {
			clearTimeout(this._saveTimer);
			this.persist();
		}
	}

	async activateView() {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
		if (!leaf) {
			leaf = workspace.getLeaf("tab");
			await leaf.setViewState({ type: VIEW_TYPE, active: true });
		}
		workspace.revealLeaf(leaf);
	}

	isExcluded(path) {
		return this.settings.excludeFolders.some((f) => {
			if (!f) return false;
			const prefix = f.endsWith("/") ? f : f + "/";
			return path === f || path.startsWith(prefix);
		});
	}

	isTrackable(file) {
		if (!file || !(file instanceof TFile)) return false;
		if (!this.settings.trackNonMarkdown && file.extension !== "md") return false;
		if (this.isExcluded(file.path)) return false;
		return true;
	}

	onFileOpen(file) {
		if (!this.isTrackable(file)) {
			this.session = null;
			return;
		}
		this.recordOpen(file);
		this.session = { path: file.path, lastActivity: Date.now() };
	}

	// Counts an "open" toward total/range visits, unless the same note was already
	// counted within the cooldown window (so rapid back-and-forth clicking doesn't
	// inflate the count).
	recordOpen(file) {
		const now = new Date();
		const existing = this.notes[file.path];

		if (existing) {
			const cooldownMs = (this.settings.visitCooldownMinutes || 0) * 60000;
			const elapsedMs = now.getTime() - new Date(existing.last).getTime();
			if (elapsedMs < cooldownMs) return;
		}

		const key = dateKey(now);
		const entry =
			existing ||
			(this.notes[file.path] = {
				total: 0,
				first: now.toISOString(),
				last: now.toISOString(),
				daily: {},
				activeSeconds: 0,
				activeDaily: {},
			});

		entry.total += 1;
		entry.last = now.toISOString();
		entry.daily[key] = (entry.daily[key] || 0) + 1;

		this.scheduleSave();
		this.refreshViews();
	}

	// Fires every TICK_SECONDS. Adds active time to the currently open note only if
	// there's been mouse/keyboard/scroll/touch activity within the idle threshold —
	// this is what keeps sleep, or stepping away, from inflating active time: no
	// activity events fire during sleep, so the gap since lastActivity reads as idle
	// the moment the machine wakes, regardless of how long it was actually asleep.
	tick() {
		if (!this.session) return;
		const idleLimitMs = (this.settings.idleThresholdMinutes || 1) * 60000;
		const now = Date.now();
		if (now - this.session.lastActivity > idleLimitMs) return;

		const entry = this.notes[this.session.path];
		if (!entry) return;

		entry.activeSeconds = (entry.activeSeconds || 0) + TICK_SECONDS;
		const key = dateKey(new Date(now));
		entry.activeDaily[key] = (entry.activeDaily[key] || 0) + TICK_SECONDS;

		this.scheduleSave();
		this.refreshViews();
	}

	handleRename(file, oldPath) {
		if (!(file instanceof TFile)) return;
		if (!this.notes[oldPath]) return;

		const moved = this.notes[oldPath];
		delete this.notes[oldPath];

		if (this.notes[file.path]) {
			const existing = this.notes[file.path];
			existing.total += moved.total;
			existing.activeSeconds = (existing.activeSeconds || 0) + (moved.activeSeconds || 0);
			existing.first = moved.first < existing.first ? moved.first : existing.first;
			existing.last = moved.last > existing.last ? moved.last : existing.last;
			for (const [day, count] of Object.entries(moved.daily)) {
				existing.daily[day] = (existing.daily[day] || 0) + count;
			}
			for (const [day, secs] of Object.entries(moved.activeDaily || {})) {
				existing.activeDaily[day] = (existing.activeDaily[day] || 0) + secs;
			}
		} else {
			this.notes[file.path] = moved;
		}

		// If the note that was just renamed is the one currently being tracked, follow it.
		if (this.session && this.session.path === oldPath) {
			this.session.path = file.path;
		}

		this.scheduleSave();
		this.refreshViews();
	}

	handleDelete(file) {
		if (!(file instanceof TFile)) return;
		if (this.notes[file.path]) {
			delete this.notes[file.path];
			this.scheduleSave();
			this.refreshViews();
		}
	}

	pruneMissing(notify) {
		let removed = 0;
		for (const path of Object.keys(this.notes)) {
			if (!this.app.vault.getAbstractFileByPath(path)) {
				delete this.notes[path];
				removed++;
			}
		}
		this.scheduleSave();
		this.refreshViews();
		if (notify) {
			new Notice(`Note Visit Tracker: pruned ${removed} entr${removed === 1 ? "y" : "ies"} for missing files.`);
		}
		return removed;
	}

	scheduleSave() {
		if (this._saveTimer) clearTimeout(this._saveTimer);
		this._saveTimer = setTimeout(() => this.persist(), 3000);
	}

	async persist() {
		this._saveTimer = null;
		await this.saveData({ settings: this.settings, notes: this.notes });
	}

	refreshViews() {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			if (leaf.view && leaf.view.scheduleRender) leaf.view.scheduleRender();
		}
	}

	// Sum a daily-bucketed object (visit counts or active seconds) over [startKey, endKey]
	// inclusive, both "YYYY-MM-DD" strings.
	sumDaily(dailyObj, startKey, endKey) {
		let sum = 0;
		for (const [day, val] of Object.entries(dailyObj || {})) {
			if (day >= startKey && day <= endKey) sum += val;
		}
		return sum;
	}

	rangeCount(entry, startKey, endKey) {
		return this.sumDaily(entry.daily, startKey, endKey);
	}

	activeRangeSeconds(entry, startKey, endKey) {
		return this.sumDaily(entry.activeDaily, startKey, endKey);
	}

	getNoteTags(path) {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!file) return [];
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache) return [];
		const tags = getAllTags(cache) || [];
		return tags.map((t) => t.replace(/^#/, ""));
	}

	async importLegacyLog() {
		const path = this.settings.legacyLogPath;
		const exists = await this.app.vault.adapter.exists(path);
		if (!exists) {
			new Notice(`Note Visit Tracker: no legacy log found at "${path}".`);
			return;
		}

		const raw = await this.app.vault.adapter.read(path);
		const lines = raw.split("\n").filter((l) => l.trim().length > 0);

		let imported = 0;
		let skipped = 0;
		const touched = new Set();

		for (const line of lines) {
			let event;
			try {
				event = JSON.parse(line);
			} catch (e) {
				skipped++;
				continue;
			}
			if (!event || event.type !== "open" || !event.path || !event.ts) {
				skipped++;
				continue;
			}
			if (!this.app.vault.getAbstractFileByPath(event.path)) {
				// Path no longer exists under this exact name (likely renamed/moved before import).
				skipped++;
				continue;
			}

			const d = new Date(event.ts);
			if (isNaN(d.getTime())) {
				skipped++;
				continue;
			}

			const key = dateKey(d);
			const iso = d.toISOString();
			const entry =
				this.notes[event.path] ||
				(this.notes[event.path] = {
					total: 0,
					first: iso,
					last: iso,
					daily: {},
					activeSeconds: 0,
					activeDaily: {},
				});

			entry.total += 1;
			entry.daily[key] = (entry.daily[key] || 0) + 1;
			if (iso < entry.first) entry.first = iso;
			if (iso > entry.last) entry.last = iso;

			imported++;
			touched.add(event.path);
		}

		this.settings.legacyImported = true;
		this.scheduleSave();
		this.refreshViews();
		new Notice(
			`Note Visit Tracker: imported ${imported} events across ${touched.size} notes. Skipped ${skipped} (renamed/missing/unparseable).`
		);
	}
}

class NoteVisitTrackerView extends ItemView {
	constructor(leaf, plugin) {
		super(leaf);
		this.plugin = plugin;
		this.activeTab = "notes";
		this.sortKey = "range";
		this.sortDir = "desc";
		this.tagSortKey = "range";
		this.tagSortDir = "desc";
		this.search = "";
		this.tagFilter = null;
		this.end = dateKey(new Date());
		this.start = dateKey(addDays(new Date(), -(plugin.settings.defaultRangeDays - 1)));
		this.trendingGranularity = "month";
		this.trendingMetric = "opens";
		this._renderScheduled = false;
	}

	getViewType() {
		return VIEW_TYPE;
	}

	getDisplayText() {
		return "Note Visit Tracker";
	}

	getIcon() {
		return "trending-up";
	}

	async onOpen() {
		this.buildChrome();
		this.render();
	}

	async onClose() {}

	scheduleRender() {
		if (this._renderScheduled) return;
		this._renderScheduled = true;
		requestAnimationFrame(() => {
			this._renderScheduled = false;
			this.render();
		});
	}

	buildChrome() {
		const container = this.containerEl.children[1];
		container.empty();
		container.addClass("note-visit-tracker-view");

		const header = container.createDiv({ cls: "nvt-header" });
		header.createEl("h3", { text: "Note Visit Tracker" });

		const tabs = header.createDiv({ cls: "nvt-tabs" });
		this.notesTabBtn = tabs.createEl("button", { text: "Notes", cls: "nvt-tab-btn" });
		this.tagsTabBtn = tabs.createEl("button", { text: "Tags", cls: "nvt-tab-btn" });
		this.trendingTabBtn = tabs.createEl("button", { text: "Trending", cls: "nvt-tab-btn" });
		this.paramsTabBtn = tabs.createEl("button", { text: "Parameters", cls: "nvt-tab-btn" });
		this.notesTabBtn.onclick = () => {
			this.activeTab = "notes";
			this.render();
		};
		this.tagsTabBtn.onclick = () => {
			this.activeTab = "tags";
			this.render();
		};
		this.trendingTabBtn.onclick = () => {
			this.activeTab = "trending";
			this.render();
		};
		this.paramsTabBtn.onclick = () => {
			this.activeTab = "parameters";
			this.render();
		};

		const controls = header.createDiv({ cls: "nvt-controls" });
		this.controlsEl = controls;

		const presetWrap = controls.createDiv({ cls: "nvt-presets" });
		[7, 30, 90, 365].forEach((days) => {
			const btn = presetWrap.createEl("button", { text: `${days}d` });
			btn.onclick = () => {
				this.end = dateKey(new Date());
				this.start = dateKey(addDays(new Date(), -(days - 1)));
				this.render();
			};
		});
		const allBtn = presetWrap.createEl("button", { text: "All time" });
		allBtn.onclick = () => {
			this.start = "0000-01-01";
			this.end = "9999-12-31";
			this.render();
		};

		const rangeWrap = controls.createDiv({ cls: "nvt-range" });
		rangeWrap.createEl("label", { text: "From" });
		this.startInput = rangeWrap.createEl("input", { type: "date" });
		rangeWrap.createEl("label", { text: "To" });
		this.endInput = rangeWrap.createEl("input", { type: "date" });
		this.startInput.onchange = () => {
			this.start = this.startInput.value || this.start;
			this.render();
		};
		this.endInput.onchange = () => {
			this.end = this.endInput.value || this.end;
			this.render();
		};

		const searchWrap = controls.createDiv({ cls: "nvt-search" });
		this.searchInput = searchWrap.createEl("input", { type: "text" });
		this.searchInput.placeholder = "Filter by note path, or tag name on the Tags tab...";
		this.searchInput.oninput = () => {
			this.search = this.searchInput.value.toLowerCase();
			this.render();
		};

		this.tagFilterBadge = header.createDiv({ cls: "nvt-tag-filter-badge" });

		this.body = container.createDiv({ cls: "nvt-body" });
	}

	render() {
		if (!this.body) return;

		this.notesTabBtn.toggleClass("is-active", this.activeTab === "notes");
		this.tagsTabBtn.toggleClass("is-active", this.activeTab === "tags");
		this.trendingTabBtn.toggleClass("is-active", this.activeTab === "trending");
		this.paramsTabBtn.toggleClass("is-active", this.activeTab === "parameters");

		this.controlsEl.toggleClass("is-hidden", this.activeTab === "parameters" || this.activeTab === "trending");

		this.startInput.value = this.start === "0000-01-01" ? "" : this.start;
		this.endInput.value = this.end === "9999-12-31" ? "" : this.end;

		this.tagFilterBadge.empty();
		if (this.tagFilter) {
			const badge = this.tagFilterBadge.createEl("span", { text: `Filtered by tag: ${this.tagFilter} ` });
			const clear = badge.createEl("button", { text: "×" });
			clear.onclick = () => {
				this.tagFilter = null;
				this.render();
			};
		}

		this.body.empty();
		if (this.activeTab === "notes") {
			this.renderNotesTab();
		} else if (this.activeTab === "tags") {
			this.renderTagsTab();
		} else if (this.activeTab === "trending") {
			this.renderTrendingTab();
		} else {
			this.renderParametersTab();
		}
	}

	// The period immediately preceding the current range, of the same length, for the
	// Trend column. Null for an "All time" range — there's no meaningful prior period
	// to compare against before the beginning of time.
	getPreviousRange() {
		if (this.start === "0000-01-01" || this.end === "9999-12-31") return null;
		const startDate = new Date(this.start + "T00:00:00");
		const endDate = new Date(this.end + "T00:00:00");
		const lengthDays = Math.round((endDate - startDate) / 86400000) + 1;
		const prevEnd = addDays(startDate, -1);
		const prevStart = addDays(prevEnd, -(lengthDays - 1));
		return { prevStart: dateKey(prevStart), prevEnd: dateKey(prevEnd), lengthDays };
	}

	// current vs. previous-period-of-equal-length for whichever metric (opens or
	// active seconds) is configured, plus a downsampled sparkline spanning both
	// periods (always split exactly in half, since the periods are equal length).
	computeTrend(entry, prevRange) {
		if (!prevRange) return null;
		const isActive = this.plugin.settings.trendMetric === "active";
		const dailyObj = isActive ? entry.activeDaily : entry.daily;
		const current = this.plugin.sumDaily(dailyObj, this.start, this.end);
		const previous = this.plugin.sumDaily(dailyObj, prevRange.prevStart, prevRange.prevEnd);
		const sparkDays = enumerateDayKeys(prevRange.prevStart, this.end);
		const sparkValues = downsample(
			sparkDays.map((d) => (dailyObj && dailyObj[d]) || 0),
			40
		);
		return { current, previous, delta: current - previous, sparkValues };
	}

	// Rows for every tracked, still-existing note, with total/range visit counts and live tags.
	// Does not apply tagFilter or search — callers filter as needed.
	getBaseRows() {
		const plugin = this.plugin;
		const prevRange = this.getPreviousRange();
		const rows = [];
		for (const [path, entry] of Object.entries(plugin.notes)) {
			const file = plugin.app.vault.getAbstractFileByPath(path);
			if (!file) continue;
			if (entry.total < plugin.settings.minVisits) continue;
			rows.push({
				path,
				name: file.basename,
				total: entry.total,
				range: plugin.rangeCount(entry, this.start, this.end),
				activeTotal: entry.activeSeconds || 0,
				activeRange: plugin.activeRangeSeconds(entry, this.start, this.end),
				last: entry.last,
				tags: plugin.getNoteTags(path),
				trend: this.computeTrend(entry, prevRange),
			});
		}
		return rows;
	}

	renderNotesTab() {
		let rows = this.getBaseRows();
		if (this.search) rows = rows.filter((r) => r.path.toLowerCase().includes(this.search));
		if (this.tagFilter) rows = rows.filter((r) => r.tags.includes(this.tagFilter));

		rows.sort((a, b) => {
			let diff = 0;
			if (this.sortKey === "name") diff = a.name.localeCompare(b.name);
			else if (this.sortKey === "total") diff = a.total - b.total;
			else if (this.sortKey === "trend") diff = (a.trend ? a.trend.delta : 0) - (b.trend ? b.trend.delta : 0);
			else if (this.sortKey === "activeRange") diff = a.activeRange - b.activeRange;
			else if (this.sortKey === "activeTotal") diff = a.activeTotal - b.activeTotal;
			else if (this.sortKey === "last") diff = new Date(a.last) - new Date(b.last);
			else diff = a.range - b.range;
			return this.sortDir === "desc" ? -diff : diff;
		});

		const trendLabel = `Trend (${this.plugin.settings.trendMetric === "active" ? "Active" : "Opens"})`;

		const table = this.body.createEl("table", { cls: "nvt-table" });
		const thead = table.createEl("thead");
		const hr = thead.createEl("tr");
		[
			["name", "Note"],
			["total", "Opens"],
			["range", "Opens (range)"],
			["trend", trendLabel],
			["activeRange", "Active (range)"],
			["activeTotal", "Active (total)"],
			["last", "Last visited"],
		].forEach(([key, label]) => {
			const arrow = this.sortKey === key ? (this.sortDir === "desc" ? " ↓" : " ↑") : "";
			const th = hr.createEl("th", { text: label + arrow });
			th.onclick = () => {
				if (this.sortKey === key) this.sortDir = this.sortDir === "desc" ? "asc" : "desc";
				else {
					this.sortKey = key;
					this.sortDir = "desc";
				}
				this.render();
			};
		});
		hr.createEl("th", { text: "Tags" });

		const tbody = table.createEl("tbody");
		if (rows.length === 0) {
			const tr = tbody.createEl("tr");
			tr.createEl("td", { text: "No visited notes match these filters.", attr: { colspan: "8" } });
		}
		for (const row of rows) {
			const tr = tbody.createEl("tr");
			const nameTd = tr.createEl("td");
			const link = nameTd.createEl("a", { text: row.name, cls: "nvt-note-link" });
			link.onclick = (e) => {
				e.preventDefault();
				const file = this.plugin.app.vault.getAbstractFileByPath(row.path);
				if (file) this.plugin.app.workspace.getLeaf(false).openFile(file);
			};
			tr.createEl("td", { text: String(row.total) });
			tr.createEl("td", { text: String(row.range) });
			this.renderTrendCell(tr.createEl("td", { cls: "nvt-trend-cell" }), row.trend);
			tr.createEl("td", { text: formatDuration(row.activeRange) });
			tr.createEl("td", { text: formatDuration(row.activeTotal) });
			tr.createEl("td", { text: row.last ? new Date(row.last).toLocaleString() : "" });
			const tagTd = tr.createEl("td");
			row.tags.forEach((t) => {
				const chip = tagTd.createEl("span", { text: t, cls: "nvt-tag-chip" });
				chip.onclick = () => {
					this.activeTab = "tags";
					this.search = t.toLowerCase();
					this.searchInput.value = t;
					this.render();
				};
			});
		}
	}

	// trend is null for an "All time" range (no prior period to compare against).
	renderTrendCell(td, trend) {
		if (!trend) {
			td.setText("—");
			return;
		}

		const { delta, previous, sparkValues } = trend;
		const isActive = this.plugin.settings.trendMetric === "active";
		const isPercent = this.plugin.settings.trendDisplay === "percent";
		const dirClass = delta > 0 ? "nvt-trend-up" : delta < 0 ? "nvt-trend-down" : "nvt-trend-flat";
		const arrow = delta > 0 ? "↑" : delta < 0 ? "↓" : "→";

		let label;
		if (delta === 0) {
			label = isPercent ? "0%" : isActive ? "0s" : "0";
		} else if (isPercent && previous === 0) {
			label = "New";
		} else if (isPercent) {
			label = `${arrow}${Math.abs(Math.round((delta / previous) * 100))}%`;
		} else {
			label = `${arrow}${isActive ? formatDuration(Math.abs(delta)) : Math.abs(delta)}`;
		}

		td.createSpan({ text: label, cls: ["nvt-trend-label", dirClass] });
		this.renderSparkline(td, sparkValues, dirClass);
	}

	// Bar sparkline spanning the previous + current period (always split exactly in
	// half, since both periods are the same length), with a divider at the midpoint.
	renderSparkline(parent, values, dirClass) {
		const width = 70;
		const height = 20;
		const max = Math.max(1, ...values);
		const n = Math.max(values.length, 1);
		const barWidth = width / n;

		const svg = parent.createSvg("svg", {
			cls: "nvt-sparkline",
			attr: { viewBox: `0 0 ${width} ${height}`, width, height },
		});
		values.forEach((v, i) => {
			const h = v > 0 ? Math.max((v / max) * height, 1) : 0;
			svg.createSvg("rect", {
				cls: ["nvt-spark-bar", dirClass],
				attr: {
					x: (i * barWidth).toFixed(2),
					y: (height - h).toFixed(2),
					width: Math.max(barWidth - 0.4, 0.6).toFixed(2),
					height: h.toFixed(2),
				},
			});
		});
		svg.createSvg("line", {
			cls: "nvt-spark-divider",
			attr: { x1: width / 2, x2: width / 2, y1: 0, y2: height },
		});
	}

	renderTagsTab() {
		const base = this.getBaseRows();
		const agg = {};
		for (const row of base) {
			for (const tag of row.tags) {
				if (!agg[tag]) {
					agg[tag] = {
						tag,
						notes: new Set(),
						total: 0,
						range: 0,
						activeTotal: 0,
						activeRange: 0,
						// row.trend is either present for every row this render (same date
						// range for all) or null for every row (All-time) — never mixed.
						trend: row.trend
							? { current: 0, previous: 0, delta: 0, sparkValues: new Array(row.trend.sparkValues.length).fill(0) }
							: null,
					};
				}
				const a = agg[tag];
				a.notes.add(row.path);
				a.total += row.total;
				a.range += row.range;
				a.activeTotal += row.activeTotal;
				a.activeRange += row.activeRange;
				if (a.trend && row.trend) {
					a.trend.current += row.trend.current;
					a.trend.previous += row.trend.previous;
					a.trend.delta += row.trend.delta;
					row.trend.sparkValues.forEach((v, i) => {
						a.trend.sparkValues[i] += v;
					});
				}
			}
		}

		let tagRows = Object.values(agg);
		if (this.search) tagRows = tagRows.filter((r) => r.tag.toLowerCase().includes(this.search));

		tagRows.sort((a, b) => {
			let diff = 0;
			if (this.tagSortKey === "tag") diff = a.tag.localeCompare(b.tag);
			else if (this.tagSortKey === "notes") diff = a.notes.size - b.notes.size;
			else if (this.tagSortKey === "total") diff = a.total - b.total;
			else if (this.tagSortKey === "trend") diff = (a.trend ? a.trend.delta : 0) - (b.trend ? b.trend.delta : 0);
			else if (this.tagSortKey === "activeRange") diff = a.activeRange - b.activeRange;
			else if (this.tagSortKey === "activeTotal") diff = a.activeTotal - b.activeTotal;
			else diff = a.range - b.range;
			return this.tagSortDir === "desc" ? -diff : diff;
		});

		const trendLabel = `Trend (${this.plugin.settings.trendMetric === "active" ? "Active" : "Opens"})`;

		const table = this.body.createEl("table", { cls: "nvt-table" });
		const thead = table.createEl("thead");
		const hr = thead.createEl("tr");
		[
			["tag", "Tag"],
			["notes", "# Notes"],
			["total", "Opens"],
			["range", "Opens (range)"],
			["trend", trendLabel],
			["activeRange", "Active (range)"],
			["activeTotal", "Active (total)"],
		].forEach(([key, label]) => {
			const arrow = this.tagSortKey === key ? (this.tagSortDir === "desc" ? " ↓" : " ↑") : "";
			const th = hr.createEl("th", { text: label + arrow });
			th.onclick = () => {
				if (this.tagSortKey === key) this.tagSortDir = this.tagSortDir === "desc" ? "asc" : "desc";
				else {
					this.tagSortKey = key;
					this.tagSortDir = "desc";
				}
				this.render();
			};
		});

		const tbody = table.createEl("tbody");
		if (tagRows.length === 0) {
			const tr = tbody.createEl("tr");
			tr.createEl("td", { text: "No tagged, visited notes match these filters.", attr: { colspan: "7" } });
		}
		for (const row of tagRows) {
			const tr = tbody.createEl("tr");
			const tagTd = tr.createEl("td");
			const link = tagTd.createEl("a", { text: row.tag, cls: "nvt-note-link" });
			link.onclick = (e) => {
				e.preventDefault();
				this.activeTab = "notes";
				this.tagFilter = row.tag;
				this.search = "";
				this.searchInput.value = "";
				this.render();
			};
			tr.createEl("td", { text: String(row.notes.size) });
			tr.createEl("td", { text: String(row.total) });
			tr.createEl("td", { text: String(row.range) });
			this.renderTrendCell(tr.createEl("td", { cls: "nvt-trend-cell" }), row.trend);
			tr.createEl("td", { text: formatDuration(row.activeRange) });
			tr.createEl("td", { text: formatDuration(row.activeTotal) });
		}
	}

	// Full ranking (not just top N) of every tracked, still-existing note within a
	// period, by the chosen metric. Returns [] entries excluded (nothing happened).
	rankNotesForPeriod(range, metric) {
		const rows = [];
		for (const [path, entry] of Object.entries(this.plugin.notes)) {
			const file = this.plugin.app.vault.getAbstractFileByPath(path);
			if (!file) continue;
			const dailyObj = metric === "active" ? entry.activeDaily : entry.daily;
			const value = this.plugin.sumDaily(dailyObj, range.start, range.end);
			if (value > 0) rows.push({ key: path, name: file.basename, value, tags: this.plugin.getNoteTags(path) });
		}
		rows.sort((a, b) => b.value - a.value);
		return rows;
	}

	// Rolls a period's note ranking up into a tag ranking, summing each tag's notes'
	// values — reuses the already-computed note ranking rather than re-scanning.
	rankTagsForPeriod(noteRanking) {
		const agg = {};
		noteRanking.forEach((r) => {
			r.tags.forEach((t) => {
				agg[t] = (agg[t] || 0) + r.value;
			});
		});
		return Object.entries(agg)
			.map(([tag, value]) => ({ key: tag, name: tag, value }))
			.sort((a, b) => b.value - a.value);
	}

	// Compares an entry's position in this period's top list against the previous
	// period's top list (both already sliced to top N): "new" if it wasn't there at
	// all, "up"/"down" if its rank improved/worsened, "same" otherwise.
	computeMovement(key, currentTop, previousTop) {
		const idxCur = currentTop.findIndex((e) => e.key === key);
		const idxPrev = previousTop.findIndex((e) => e.key === key);
		if (idxPrev === -1) return "new";
		if (idxCur < idxPrev) return "up";
		if (idxCur > idxPrev) return "down";
		return "same";
	}

	renderTopList(parent, heading, topEntries, previousTop, metric, isNote) {
		const col = parent.createDiv({ cls: "nvt-trending-col" });
		col.createEl("div", { text: heading, cls: "nvt-trending-col-heading" });

		if (topEntries.length === 0) {
			col.createEl("div", { text: "No activity.", cls: "nvt-trending-empty" });
			return;
		}

		const list = col.createEl("ol", { cls: "nvt-trending-list" });
		topEntries.forEach((entry) => {
			const li = list.createEl("li");
			const movement = this.computeMovement(entry.key, topEntries, previousTop);
			li.createEl("span", {
				text: movementSymbol(movement),
				cls: ["nvt-trending-move", `nvt-trending-move-${movement}`],
			});

			const nameEl = li.createEl("span", { text: entry.name, cls: ["nvt-trending-name", "nvt-note-link"] });
			if (isNote) {
				const file = this.plugin.app.vault.getAbstractFileByPath(entry.key);
				nameEl.onclick = () => {
					if (file) this.plugin.app.workspace.getLeaf(false).openFile(file);
				};
			} else {
				nameEl.onclick = () => {
					this.activeTab = "notes";
					this.tagFilter = entry.key;
					this.render();
				};
			}

			li.createEl("span", {
				text: metric === "active" ? formatDuration(entry.value) : String(entry.value),
				cls: "nvt-trending-value",
			});
		});
	}

	renderTrendingTab() {
		const wrap = this.body.createDiv({ cls: "nvt-trending" });

		const controls = wrap.createDiv({ cls: "nvt-trending-controls" });

		const granWrap = controls.createDiv({ cls: "nvt-trending-toggle" });
		[
			["month", "Monthly"],
			["week", "Weekly"],
		].forEach(([key, label]) => {
			const btn = granWrap.createEl("button", { text: label, cls: "nvt-tab-btn" });
			btn.toggleClass("is-active", this.trendingGranularity === key);
			btn.onclick = () => {
				this.trendingGranularity = key;
				this.render();
			};
		});

		const metricWrap = controls.createDiv({ cls: "nvt-trending-toggle" });
		[
			["opens", "Opens"],
			["active", "Active time"],
		].forEach(([key, label]) => {
			const btn = metricWrap.createEl("button", { text: label, cls: "nvt-tab-btn" });
			btn.toggleClass("is-active", this.trendingMetric === key);
			btn.onclick = () => {
				this.trendingMetric = key;
				this.render();
			};
		});

		if (this.trendingMetric === "active") {
			wrap.createEl("div", {
				cls: "nvt-trending-caveat",
				text: "Active-time tracking is newer than opens tracking, so earlier periods may undercount active time relative to opens.",
			});
		}

		const periodCount = this.trendingGranularity === "week" ? 12 : 6;
		// One extra period computed (not displayed) so the oldest shown period still
		// has something to compare rank movement against.
		const ranges = getPeriodRanges(this.trendingGranularity, periodCount + 1);
		const noteRankings = ranges.map((r) => this.rankNotesForPeriod(r, this.trendingMetric));
		const tagRankings = noteRankings.map((nr) => this.rankTagsForPeriod(nr));

		for (let i = 0; i < periodCount; i++) {
			const periodEl = wrap.createDiv({ cls: "nvt-trending-period" });
			periodEl.createEl("div", { text: ranges[i].label, cls: "nvt-trending-period-label" });

			const cols = periodEl.createDiv({ cls: "nvt-trending-cols" });
			const prevNotes = (noteRankings[i + 1] || []).slice(0, 3);
			const prevTags = (tagRankings[i + 1] || []).slice(0, 3);
			this.renderTopList(cols, "Top notes", noteRankings[i].slice(0, 3), prevNotes, this.trendingMetric, true);
			this.renderTopList(cols, "Top tags", tagRankings[i].slice(0, 3), prevTags, this.trendingMetric, false);
		}
	}

	renderParametersTab() {
		const settings = this.plugin.settings;
		const wrap = this.body.createDiv({ cls: "nvt-params" });

		const PARAMS = [
			{
				key: "visitCooldownMinutes",
				label: "Visit cooldown (minutes)",
				desc: "Reopening the same note within this many minutes of your last recorded visit doesn't count as a new visit. Set to 0 to disable.",
				min: 0,
			},
			{
				key: "idleThresholdMinutes",
				label: "Idle threshold (minutes)",
				desc: "While a note is open, active time only accumulates if there's been mouse, keyboard, scroll, or touch activity within this many minutes. Keeps sleep, or stepping away, from inflating active time.",
				min: 1,
			},
			{
				key: "defaultRangeDays",
				label: "Default range (days)",
				desc: "How many days back this view opens to by default. The date range itself stays freeform — this only sets the starting point for newly opened views.",
				min: 1,
			},
			{
				key: "minVisits",
				label: "Minimum visits to display",
				desc: "Hide notes with fewer than this many total (all-time) visits from both the Notes and Tags tabs.",
				min: 0,
			},
		];

		PARAMS.forEach((p) => {
			const row = wrap.createDiv({ cls: "nvt-param-row" });

			const labelWrap = row.createDiv({ cls: "nvt-param-label" });
			labelWrap.createEl("div", { text: p.label, cls: "nvt-param-name" });
			labelWrap.createEl("div", { text: p.desc, cls: "nvt-param-desc" });

			const inputWrap = row.createDiv({ cls: "nvt-param-input" });
			const input = inputWrap.createEl("input", { type: "number" });
			input.value = String(settings[p.key]);
			input.min = String(p.min);
			input.step = "1";

			const saved = inputWrap.createEl("span", { text: "Saved", cls: "nvt-param-saved" });

			input.onchange = async () => {
				const n = parseInt(input.value, 10);
				if (isNaN(n) || n < p.min) {
					input.value = String(settings[p.key]);
					return;
				}
				settings[p.key] = n;
				await this.plugin.persist();
				this.flashSaved(saved);
			};
		});

		wrap.createEl("div", { text: "Trend column", cls: "nvt-param-section" });

		const SELECTS = [
			{
				key: "trendMetric",
				label: "Trend metric",
				desc: "What the Trend column and its sparkline compare: opens, or active time.",
				options: [
					{ value: "opens", label: "Opens" },
					{ value: "active", label: "Active time" },
				],
			},
			{
				key: "trendDisplay",
				label: "Trend comparison",
				desc: "How the delta is shown: a raw count/time difference, or a percent change versus the previous period.",
				options: [
					{ value: "delta", label: "Count difference" },
					{ value: "percent", label: "Percent change" },
				],
			},
		];

		SELECTS.forEach((p) => {
			const row = wrap.createDiv({ cls: "nvt-param-row" });

			const labelWrap = row.createDiv({ cls: "nvt-param-label" });
			labelWrap.createEl("div", { text: p.label, cls: "nvt-param-name" });
			labelWrap.createEl("div", { text: p.desc, cls: "nvt-param-desc" });

			const inputWrap = row.createDiv({ cls: "nvt-param-input" });
			const select = inputWrap.createEl("select");
			p.options.forEach((opt) => select.createEl("option", { text: opt.label, value: opt.value }));
			select.value = settings[p.key];

			const saved = inputWrap.createEl("span", { text: "Saved", cls: "nvt-param-saved" });

			select.onchange = async () => {
				settings[p.key] = select.value;
				await this.plugin.persist();
				this.flashSaved(saved);
			};
		});
	}

	flashSaved(el) {
		el.addClass("is-visible");
		setTimeout(() => el.removeClass("is-visible"), 1200);
	}
}

class NoteVisitTrackerSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Note Visit Tracker" });

		new Setting(containerEl)
			.setName("Track non-markdown files")
			.setDesc("Also count visits to non-.md files (PDFs, images, etc.) opened in the editor.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.trackNonMarkdown).onChange(async (v) => {
					this.plugin.settings.trackNonMarkdown = v;
					await this.plugin.persist();
				})
			);

		new Setting(containerEl)
			.setName("Default range (days)")
			.setDesc(
				"How many days back the tracker view opens to by default. The view's date range is fully freeform after that — this just sets the starting point."
			)
			.addText((t) =>
				t.setValue(String(this.plugin.settings.defaultRangeDays)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (!isNaN(n) && n > 0) {
						this.plugin.settings.defaultRangeDays = n;
						await this.plugin.persist();
					}
				})
			);

		new Setting(containerEl)
			.setName("Visit cooldown (minutes)")
			.setDesc(
				"Reopening the same note within this many minutes of your last recorded visit doesn't count as a new visit — keeps rapid back-and-forth clicking from inflating the count. Set to 0 to disable."
			)
			.addText((t) =>
				t.setValue(String(this.plugin.settings.visitCooldownMinutes)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (!isNaN(n) && n >= 0) {
						this.plugin.settings.visitCooldownMinutes = n;
						await this.plugin.persist();
					}
				})
			);

		new Setting(containerEl)
			.setName("Idle threshold (minutes)")
			.setDesc(
				"While a note is open, active time only accumulates if there's been mouse, keyboard, scroll, or touch activity within this many minutes. This is what keeps your computer sleeping, or you stepping away, from counting as active time on whatever note was open."
			)
			.addText((t) =>
				t.setValue(String(this.plugin.settings.idleThresholdMinutes)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (!isNaN(n) && n > 0) {
						this.plugin.settings.idleThresholdMinutes = n;
						await this.plugin.persist();
					}
				})
			);

		new Setting(containerEl)
			.setName("Minimum visits to display")
			.setDesc("Hide notes with fewer than this many total (all-time) visits from the tracker view.")
			.addText((t) =>
				t.setValue(String(this.plugin.settings.minVisits)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (!isNaN(n) && n >= 0) {
						this.plugin.settings.minVisits = n;
						await this.plugin.persist();
					}
				})
			);

		new Setting(containerEl)
			.setName("Excluded folders")
			.setDesc(
				"One folder path per line. Notes inside these folders are never tracked going forward. Paths are relative to the vault root, no leading slash."
			)
			.addTextArea((t) => {
				t.setValue(this.plugin.settings.excludeFolders.join("\n"));
				t.onChange(async (v) => {
					this.plugin.settings.excludeFolders = v
						.split("\n")
						.map((s) => s.trim())
						.filter(Boolean);
					await this.plugin.persist();
				});
			});

		containerEl.createEl("h3", { text: "Maintenance" });

		new Setting(containerEl)
			.setName("Prune missing notes")
			.setDesc("Remove tracker entries for notes that have been deleted outside of Obsidian.")
			.addButton((b) => b.setButtonText("Prune").onClick(() => this.plugin.pruneMissing(true)));

		containerEl.createEl("h3", { text: "Import from Note Open Tracker Plus" });
		containerEl.createEl("p", {
			text:
				"One-time import of historical opens from the old plugin's event log, so you don't lose visit history when switching trackers. Entries for paths that no longer exist under their old name (e.g. notes renamed or moved before this import) are skipped rather than guessed at.",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("Legacy log path")
			.setDesc("Vault-relative path to the old plugin's .note-open-events.ndjson file.")
			.addText((t) =>
				t.setValue(this.plugin.settings.legacyLogPath).onChange(async (v) => {
					this.plugin.settings.legacyLogPath = v.trim();
					await this.plugin.persist();
				})
			);

		new Setting(containerEl)
			.setName("Import now")
			.setDesc(
				this.plugin.settings.legacyImported
					? "Already imported once. Running again will double-count any overlapping events."
					: "Not yet imported."
			)
			.addButton((b) => b.setButtonText("Import").onClick(() => this.plugin.importLegacyLog()));
	}
}

module.exports = NoteVisitTrackerPlugin;

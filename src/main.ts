import {
  App,
  ItemView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  WorkspaceLeaf,
  requestUrl,
} from "obsidian";

// ─── Constants ────────────────────────────────────────────────────────────────

const VIEW_TYPE = "gcal-timeblock-view";
const HOUR_HEIGHT = 60; // px per hour
const DAY_START = 0;    // 0 = midnight
const DAY_END = 24;

// ─── Types ────────────────────────────────────────────────────────────────────

interface GCalEvent {
  id: string;
  summary: string;
  description?: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  colorId?: string;
  calendarId: string;
  calendarColor: string;
}

interface CalendarConfig {
  id: string;
  name: string;
  color: string;
  enabled: boolean;
}

interface GCalSettings {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken: string;
  tokenExpiry: number;
  calendars: CalendarConfig[];
  defaultView: "day" | "week";
  startHour: number;
  endHour: number;
}

const DEFAULT_SETTINGS: GCalSettings = {
  clientId: "",
  clientSecret: "",
  refreshToken: "",
  accessToken: "",
  tokenExpiry: 0,
  calendars: [],
  defaultView: "day",
  startHour: 6,
  endHour: 22,
};

// ─── Google API helpers ───────────────────────────────────────────────────────

async function refreshAccessToken(settings: GCalSettings): Promise<string> {
  if (!settings.clientId || !settings.clientSecret || !settings.refreshToken) {
    throw new Error("Google API credentials not configured.");
  }
  if (settings.accessToken && Date.now() < settings.tokenExpiry - 60000) {
    return settings.accessToken;
  }
  const resp = await requestUrl({
    url: "https://oauth2.googleapis.com/token",
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: settings.clientId,
      client_secret: settings.clientSecret,
      refresh_token: settings.refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });
  const data = resp.json;
  if (data.error) throw new Error(data.error_description || data.error);
  return data.access_token;
}

async function fetchCalendarList(token: string): Promise<CalendarConfig[]> {
  const resp = await requestUrl({
    url: "https://www.googleapis.com/calendar/v3/users/me/calendarList",
    headers: { Authorization: `Bearer ${token}` },
  });
  const items = resp.json.items || [];
  return items.map((c: any) => ({
    id: c.id,
    name: c.summary,
    color: c.backgroundColor || "#4285F4",
    enabled: true,
  }));
}

async function fetchEvents(
  token: string,
  calendarId: string,
  calendarColor: string,
  timeMin: string,
  timeMax: string
): Promise<GCalEvent[]> {
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
    calendarId
  )}/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(
    timeMax
  )}&singleEvents=true&orderBy=startTime&maxResults=250`;
  const resp = await requestUrl({
    url,
    headers: { Authorization: `Bearer ${token}` },
  });
  const items = resp.json.items || [];
  return items.map((e: any) => ({ ...e, calendarId, calendarColor }));
}

async function createEvent(
  token: string,
  calendarId: string,
  event: Partial<GCalEvent>
): Promise<GCalEvent> {
  const resp = await requestUrl({
    url: `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
      calendarId
    )}/events`,
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(event),
  });
  return resp.json;
}

async function updateEvent(
  token: string,
  calendarId: string,
  eventId: string,
  event: Partial<GCalEvent>
): Promise<GCalEvent> {
  const resp = await requestUrl({
    url: `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
      calendarId
    )}/events/${eventId}`,
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(event),
  });
  return resp.json;
}

async function deleteEvent(
  token: string,
  calendarId: string,
  eventId: string
): Promise<void> {
  await requestUrl({
    url: `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
      calendarId
    )}/events/${eventId}`,
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ─── Utility helpers ──────────────────────────────────────────────────────────

function toLocalISOString(date: Date): string {
  const off = date.getTimezoneOffset();
  const d = new Date(date.getTime() - off * 60 * 1000);
  return d.toISOString().slice(0, 16);
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
}

function startOfWeek(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDate(date: Date): string {
  return date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

// ─── Event Modal ──────────────────────────────────────────────────────────────

class EventModal extends Modal {
  private event: Partial<GCalEvent>;
  private calendars: CalendarConfig[];
  private onSave: (event: Partial<GCalEvent>, calendarId: string) => void;
  private onDelete?: () => void;
  private isEdit: boolean;

  constructor(
    app: App,
    event: Partial<GCalEvent>,
    calendars: CalendarConfig[],
    onSave: (event: Partial<GCalEvent>, calendarId: string) => void,
    onDelete?: () => void
  ) {
    super(app);
    this.event = { ...event };
    this.calendars = calendars.filter((c) => c.enabled);
    this.onSave = onSave;
    this.onDelete = onDelete;
    this.isEdit = !!event.id;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("gcal-modal");

    contentEl.createEl("h2", {
      text: this.isEdit ? "Edit Event" : "New Event",
      cls: "gcal-modal-title",
    });

    // Title
    new Setting(contentEl).setName("Title").addText((text) => {
      text.setValue(this.event.summary || "").onChange((v) => {
        this.event.summary = v;
      });
      text.inputEl.style.width = "100%";
    });

    // Calendar selector
    const calSetting = new Setting(contentEl).setName("Calendar");
    const calSelect = calSetting.controlEl.createEl("select", { cls: "gcal-select" });
    this.calendars.forEach((c) => {
      const opt = calSelect.createEl("option", { text: c.name, value: c.id });
      if (c.id === this.event.calendarId) opt.selected = true;
    });
    calSelect.onchange = () => { this.event.calendarId = calSelect.value; };
    if (!this.event.calendarId && this.calendars[0]) {
      this.event.calendarId = this.calendars[0].id;
    }

    // Start time
    const startVal = this.event.start?.dateTime
      ? toLocalISOString(new Date(this.event.start.dateTime))
      : toLocalISOString(new Date());

    new Setting(contentEl).setName("Start").addText((text) => {
      text.inputEl.type = "datetime-local";
      text.inputEl.value = startVal;
      text.inputEl.style.width = "100%";
      text.onChange((v) => {
        this.event.start = { dateTime: new Date(v).toISOString() };
      });
    });
    this.event.start = { dateTime: new Date(startVal).toISOString() };

    // End time
    const endDate = this.event.end?.dateTime
      ? new Date(this.event.end.dateTime)
      : new Date(new Date(startVal).getTime() + 60 * 60 * 1000);
    const endVal = toLocalISOString(endDate);

    new Setting(contentEl).setName("End").addText((text) => {
      text.inputEl.type = "datetime-local";
      text.inputEl.value = endVal;
      text.inputEl.style.width = "100%";
      text.onChange((v) => {
        this.event.end = { dateTime: new Date(v).toISOString() };
      });
    });
    this.event.end = { dateTime: endDate.toISOString() };

    // Description
    new Setting(contentEl).setName("Description").addTextArea((ta) => {
      ta.setValue(this.event.description || "").onChange((v) => {
        this.event.description = v;
      });
      ta.inputEl.style.width = "100%";
      ta.inputEl.rows = 3;
    });

    // Buttons
    const btnRow = contentEl.createDiv({ cls: "gcal-modal-buttons" });

    const saveBtn = btnRow.createEl("button", { text: "Save", cls: "mod-cta gcal-btn" });
    saveBtn.onclick = () => {
      if (!this.event.summary?.trim()) {
        new Notice("Please enter a title.");
        return;
      }
      this.onSave(this.event, this.event.calendarId || this.calendars[0]?.id);
      this.close();
    };

    if (this.isEdit && this.onDelete) {
      const delBtn = btnRow.createEl("button", { text: "Delete", cls: "gcal-btn gcal-btn-danger" });
      delBtn.onclick = () => {
        this.onDelete!();
        this.close();
      };
    }

    const cancelBtn = btnRow.createEl("button", { text: "Cancel", cls: "gcal-btn" });
    cancelBtn.onclick = () => this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ─── Calendar View ────────────────────────────────────────────────────────────

class GCalView extends ItemView {
  plugin: GCalTimeblockPlugin;
  private currentDate: Date;
  private viewMode: "day" | "week";
  private events: GCalEvent[] = [];
  private loading = false;

  constructor(leaf: WorkspaceLeaf, plugin: GCalTimeblockPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.currentDate = new Date();
    this.currentDate.setHours(0, 0, 0, 0);
    this.viewMode = plugin.settings.defaultView;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "GCal Timeblock"; }
  getIcon() { return "calendar-days"; }

  async onOpen() {
    await this.renderView();
  }

  async onClose() {}

  // ── Main render ──────────────────────────────────────────────────────────────

  async renderView() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("gcal-container");

    this.renderToolbar(container);

    if (!this.plugin.settings.clientId || !this.plugin.settings.refreshToken) {
      this.renderSetupPrompt(container);
      return;
    }

    if (this.loading) {
      container.createEl("div", { cls: "gcal-loading", text: "Loading events…" });
      return;
    }

    if (this.viewMode === "day") {
      this.renderDayView(container);
    } else {
      this.renderWeekView(container);
    }
  }

  // ── Toolbar ──────────────────────────────────────────────────────────────────

  renderToolbar(container: HTMLElement) {
    const toolbar = container.createDiv({ cls: "gcal-toolbar" });

    // View toggle
    const viewToggle = toolbar.createDiv({ cls: "gcal-view-toggle" });
    ["day", "week"].forEach((v) => {
      const btn = viewToggle.createEl("button", {
        text: v.charAt(0).toUpperCase() + v.slice(1),
        cls: `gcal-toggle-btn ${this.viewMode === v ? "active" : ""}`,
      });
      btn.onclick = () => {
        this.viewMode = v as "day" | "week";
        this.renderView();
      };
    });

    // Nav
    const nav = toolbar.createDiv({ cls: "gcal-nav" });

    const prevBtn = nav.createEl("button", { cls: "gcal-nav-btn", text: "←" });
    prevBtn.onclick = () => this.navigate(-1);

    const todayBtn = nav.createEl("button", { cls: "gcal-today-btn", text: "Today" });
    todayBtn.onclick = () => {
      this.currentDate = new Date();
      this.currentDate.setHours(0, 0, 0, 0);
      this.loadAndRender();
    };

    const nextBtn = nav.createEl("button", { cls: "gcal-nav-btn", text: "→" });
    nextBtn.onclick = () => this.navigate(1);

    // Date label
    const label = toolbar.createDiv({ cls: "gcal-date-label" });
    label.setText(this.getDateLabel());

    // Refresh + Add
    const actions = toolbar.createDiv({ cls: "gcal-actions" });

    const refreshBtn = actions.createEl("button", { cls: "gcal-action-btn", text: "↻" });
    refreshBtn.title = "Refresh";
    refreshBtn.onclick = () => this.loadAndRender();

    const addBtn = actions.createEl("button", { cls: "gcal-action-btn gcal-add-btn", text: "+" });
    addBtn.title = "New Event";
    addBtn.onclick = () => this.openNewEventModal();
  }

  getDateLabel(): string {
    if (this.viewMode === "day") {
      return formatDate(this.currentDate);
    } else {
      const start = startOfWeek(this.currentDate);
      const end = new Date(start);
      end.setDate(end.getDate() + 6);
      return `${start.toLocaleDateString([], { month: "short", day: "numeric" })} – ${end.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}`;
    }
  }

  navigate(dir: number) {
    if (this.viewMode === "day") {
      this.currentDate.setDate(this.currentDate.getDate() + dir);
    } else {
      this.currentDate.setDate(this.currentDate.getDate() + dir * 7);
    }
    this.loadAndRender();
  }

  // ── Setup prompt ─────────────────────────────────────────────────────────────

  renderSetupPrompt(container: HTMLElement) {
    const wrap = container.createDiv({ cls: "gcal-setup-prompt" });
    wrap.createEl("div", { cls: "gcal-setup-icon", text: "📅" });
    wrap.createEl("h3", { text: "Connect Google Calendar" });
    wrap.createEl("p", {
      text: "Configure your Google API credentials in the plugin settings to get started.",
    });
    const btn = wrap.createEl("button", { text: "Open Settings", cls: "mod-cta" });
    btn.onclick = () => {
      (this.app as any).setting.open();
      (this.app as any).setting.openTabById("gcal-timeblock");
    };
  }

  // ── Day view ─────────────────────────────────────────────────────────────────

  renderDayView(container: HTMLElement) {
    const { startHour, endHour } = this.plugin.settings;
    const dayEvents = this.getEventsForDate(this.currentDate);

    const scrollWrap = container.createDiv({ cls: "gcal-scroll-wrap" });
    const grid = scrollWrap.createDiv({ cls: "gcal-grid" });

    // Time gutter + day column
    const timeGutter = grid.createDiv({ cls: "gcal-time-gutter" });
    const dayCol = grid.createDiv({ cls: "gcal-day-col" });

    const totalHours = endHour - startHour;
    grid.style.height = `${totalHours * HOUR_HEIGHT}px`;

    // Hour lines
    for (let h = startHour; h <= endHour; h++) {
      const y = (h - startHour) * HOUR_HEIGHT;

      const timeLabel = timeGutter.createDiv({ cls: "gcal-time-label" });
      timeLabel.style.top = `${y}px`;
      if (h < 24) {
        const label = h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`;
        timeLabel.setText(label);
      }

      const line = dayCol.createDiv({ cls: "gcal-hour-line" });
      line.style.top = `${y}px`;

      // Half-hour line
      if (h < endHour) {
        const halfLine = dayCol.createDiv({ cls: "gcal-half-line" });
        halfLine.style.top = `${y + HOUR_HEIGHT / 2}px`;
      }
    }

    // Click-to-create
    dayCol.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".gcal-event")) return;
      const rect = dayCol.getBoundingClientRect();
      const relY = e.clientY - rect.top + scrollWrap.scrollTop;
      const hour = startHour + relY / HOUR_HEIGHT;
      const h = Math.floor(hour);
      const m = Math.round(((hour - h) * 60) / 15) * 15;
      const start = new Date(this.currentDate);
      start.setHours(h, m, 0, 0);
      const end = new Date(start.getTime() + 60 * 60 * 1000);
      this.openNewEventModal(start, end);
    });

    // Render events
    const positioned = this.positionEvents(dayEvents, startHour, endHour);
    positioned.forEach(({ event, top, height, left, width }) => {
      this.renderEvent(dayCol, event, top, height, left, width);
    });

    // Current time indicator
    const now = new Date();
    if (dateKey(now) === dateKey(this.currentDate)) {
      const nowMins = (now.getHours() - startHour) * 60 + now.getMinutes();
      if (nowMins >= 0 && nowMins <= totalHours * 60) {
        const nowLine = dayCol.createDiv({ cls: "gcal-now-line" });
        nowLine.style.top = `${(nowMins / 60) * HOUR_HEIGHT}px`;
        const nowDot = nowLine.createDiv({ cls: "gcal-now-dot" });
      }
    }

    // Scroll to current time or start hour
    setTimeout(() => {
      const scrollTo = Math.max(0, (now.getHours() - startHour - 1) * HOUR_HEIGHT);
      scrollWrap.scrollTop = scrollTo;
    }, 50);
  }

  // ── Week view ─────────────────────────────────────────────────────────────────

  renderWeekView(container: HTMLElement) {
    const { startHour, endHour } = this.plugin.settings;
    const weekStart = startOfWeek(this.currentDate);
    const days: Date[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart);
      d.setDate(d.getDate() + i);
      days.push(d);
    }

    // Day headers
    const headerRow = container.createDiv({ cls: "gcal-week-header-row" });
    headerRow.createDiv({ cls: "gcal-gutter-spacer" });
    const today = dateKey(new Date());
    days.forEach((d) => {
      const hdr = headerRow.createDiv({
        cls: `gcal-week-day-header ${dateKey(d) === today ? "today" : ""}`,
      });
      hdr.createEl("span", { cls: "gcal-week-dow", text: d.toLocaleDateString([], { weekday: "short" }) });
      hdr.createEl("span", {
        cls: "gcal-week-dom",
        text: String(d.getDate()),
      });
    });

    const scrollWrap = container.createDiv({ cls: "gcal-scroll-wrap" });
    const grid = scrollWrap.createDiv({ cls: "gcal-grid gcal-week-grid" });
    const totalHours = endHour - startHour;
    grid.style.height = `${totalHours * HOUR_HEIGHT}px`;

    // Time gutter
    const timeGutter = grid.createDiv({ cls: "gcal-time-gutter" });
    for (let h = startHour; h <= endHour; h++) {
      const y = (h - startHour) * HOUR_HEIGHT;
      const timeLabel = timeGutter.createDiv({ cls: "gcal-time-label" });
      timeLabel.style.top = `${y}px`;
      if (h < 24) {
        const label = h === 0 ? "12 AM" : h < 12 ? `${h} AM` : h === 12 ? "12 PM" : `${h - 12} PM`;
        timeLabel.setText(label);
      }
    }

    // Day columns
    days.forEach((day) => {
      const dayCol = grid.createDiv({
        cls: `gcal-day-col gcal-week-col ${dateKey(day) === today ? "today-col" : ""}`,
      });

      for (let h = startHour; h <= endHour; h++) {
        const y = (h - startHour) * HOUR_HEIGHT;
        const line = dayCol.createDiv({ cls: "gcal-hour-line" });
        line.style.top = `${y}px`;
        if (h < endHour) {
          const halfLine = dayCol.createDiv({ cls: "gcal-half-line" });
          halfLine.style.top = `${y + HOUR_HEIGHT / 2}px`;
        }
      }

      // Click to create
      dayCol.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest(".gcal-event")) return;
        const rect = dayCol.getBoundingClientRect();
        const relY = e.clientY - rect.top + scrollWrap.scrollTop;
        const hour = startHour + relY / HOUR_HEIGHT;
        const h = Math.floor(hour);
        const m = Math.round(((hour - h) * 60) / 15) * 15;
        const start = new Date(day);
        start.setHours(h, m, 0, 0);
        const end = new Date(start.getTime() + 60 * 60 * 1000);
        this.openNewEventModal(start, end);
      });

      const dayEvents = this.getEventsForDate(day);
      const positioned = this.positionEvents(dayEvents, startHour, endHour);
      positioned.forEach(({ event, top, height, left, width }) => {
        this.renderEvent(dayCol, event, top, height, left, width);
      });

      // Now line
      const now = new Date();
      if (dateKey(now) === dateKey(day)) {
        const nowMins = (now.getHours() - startHour) * 60 + now.getMinutes();
        if (nowMins >= 0 && nowMins <= totalHours * 60) {
          const nowLine = dayCol.createDiv({ cls: "gcal-now-line" });
          nowLine.style.top = `${(nowMins / 60) * HOUR_HEIGHT}px`;
          nowLine.createDiv({ cls: "gcal-now-dot" });
        }
      }
    });

    setTimeout(() => {
      const now = new Date();
      const scrollTo = Math.max(0, (now.getHours() - startHour - 1) * HOUR_HEIGHT);
      scrollWrap.scrollTop = scrollTo;
    }, 50);
  }

  // ── Event positioning ─────────────────────────────────────────────────────────

  positionEvents(
    events: GCalEvent[],
    startHour: number,
    endHour: number
  ): { event: GCalEvent; top: number; height: number; left: number; width: number }[] {
    const results: { event: GCalEvent; top: number; height: number; left: number; width: number }[] = [];
    const timedEvents = events.filter((e) => e.start.dateTime);

    // Simple overlap detection - group overlapping events
    const groups: GCalEvent[][] = [];
    timedEvents.forEach((event) => {
      const eStart = new Date(event.start.dateTime!).getTime();
      const eEnd = new Date(event.end.dateTime!).getTime();
      let placed = false;
      for (const group of groups) {
        const overlaps = group.some((g) => {
          const gStart = new Date(g.start.dateTime!).getTime();
          const gEnd = new Date(g.end.dateTime!).getTime();
          return eStart < gEnd && eEnd > gStart;
        });
        if (overlaps) {
          group.push(event);
          placed = true;
          break;
        }
      }
      if (!placed) groups.push([event]);
    });

    groups.forEach((group) => {
      group.forEach((event, idx) => {
        const start = new Date(event.start.dateTime!);
        const end = new Date(event.end.dateTime!);
        const startMins = (start.getHours() - startHour) * 60 + start.getMinutes();
        const endMins = (end.getHours() - startHour) * 60 + end.getMinutes();
        const clampedStart = Math.max(0, startMins);
        const clampedEnd = Math.min((endHour - startHour) * 60, endMins);
        const top = (clampedStart / 60) * HOUR_HEIGHT;
        const height = Math.max(((clampedEnd - clampedStart) / 60) * HOUR_HEIGHT, 20);
        const width = 1 / group.length;
        const left = idx / group.length;
        results.push({ event, top, height, left, width });
      });
    });

    return results;
  }

  // ── Render single event ───────────────────────────────────────────────────────

  renderEvent(
    col: HTMLElement,
    event: GCalEvent,
    top: number,
    height: number,
    left: number,
    width: number
  ) {
    const el = col.createDiv({ cls: "gcal-event" });
    el.style.top = `${top}px`;
    el.style.height = `${height}px`;
    el.style.left = `${left * 100}%`;
    el.style.width = `${width * 100 - 2}%`;
    el.style.backgroundColor = event.calendarColor + "33";
    el.style.borderLeftColor = event.calendarColor;

    const startTime = event.start.dateTime ? formatTime(new Date(event.start.dateTime)) : "";
    const endTime = event.end.dateTime ? formatTime(new Date(event.end.dateTime)) : "";

    if (height > 30) {
      el.createEl("span", { cls: "gcal-event-title", text: event.summary || "(No title)" });
      if (height > 50) {
        el.createEl("span", { cls: "gcal-event-time", text: `${startTime} – ${endTime}` });
      }
    } else {
      el.createEl("span", { cls: "gcal-event-title gcal-event-title-sm", text: event.summary || "(No title)" });
    }

    el.onclick = (e) => {
      e.stopPropagation();
      this.openEditEventModal(event);
    };

    // Drag to resize (bottom handle)
    if (height > 24) {
      const resizeHandle = el.createDiv({ cls: "gcal-resize-handle" });
      resizeHandle.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        this.startResize(e, event, el, col, top);
      });
    }
  }

  startResize(e: MouseEvent, event: GCalEvent, el: HTMLElement, col: HTMLElement, origTop: number) {
    const startY = e.clientY;
    const origHeight = el.offsetHeight;

    const onMove = (me: MouseEvent) => {
      const delta = me.clientY - startY;
      const newHeight = Math.max(20, origHeight + delta);
      el.style.height = `${newHeight}px`;
    };

    const onUp = async (me: MouseEvent) => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      const delta = me.clientY - startY;
      const newHeight = Math.max(20, origHeight + delta);
      const addedMins = Math.round(((newHeight - origHeight) / HOUR_HEIGHT) * 60 / 15) * 15;
      if (!event.end.dateTime) return;
      const newEnd = new Date(new Date(event.end.dateTime).getTime() + addedMins * 60 * 1000);
      try {
        const token = await this.getToken();
        await updateEvent(token, event.calendarId, event.id, {
          ...event,
          end: { dateTime: newEnd.toISOString() },
        });
        new Notice("Event updated.");
        this.loadAndRender();
      } catch (err: any) {
        new Notice("Failed to update event: " + err.message);
      }
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  // ── Event helpers ─────────────────────────────────────────────────────────────

  getEventsForDate(date: Date): GCalEvent[] {
    const key = dateKey(date);
    return this.events.filter((e) => {
      if (e.start.dateTime) {
        return dateKey(new Date(e.start.dateTime)) === key;
      }
      if (e.start.date) {
        return e.start.date === key;
      }
      return false;
    });
  }

  async getToken(): Promise<string> {
    const token = await refreshAccessToken(this.plugin.settings);
    this.plugin.settings.accessToken = token;
    this.plugin.settings.tokenExpiry = Date.now() + 3600 * 1000;
    await this.plugin.saveSettings();
    return token;
  }

  async loadAndRender() {
    this.loading = true;
    await this.renderView();
    this.loading = false;

    try {
      const token = await this.getToken();
      const enabledCals = this.plugin.settings.calendars.filter((c) => c.enabled);

      let timeMin: Date, timeMax: Date;
      if (this.viewMode === "day") {
        timeMin = new Date(this.currentDate);
        timeMax = new Date(this.currentDate);
        timeMax.setDate(timeMax.getDate() + 1);
      } else {
        timeMin = startOfWeek(this.currentDate);
        timeMax = new Date(timeMin);
        timeMax.setDate(timeMax.getDate() + 7);
      }

      const allEvents: GCalEvent[] = [];
      for (const cal of enabledCals) {
        try {
          const evts = await fetchEvents(
            token,
            cal.id,
            cal.color,
            timeMin.toISOString(),
            timeMax.toISOString()
          );
          allEvents.push(...evts);
        } catch (err) {
          console.warn(`Failed to fetch ${cal.name}:`, err);
        }
      }
      this.events = allEvents;
    } catch (err: any) {
      new Notice("Failed to load events: " + err.message);
    }

    this.loading = false;
    await this.renderView();
  }

  // ── Modals ────────────────────────────────────────────────────────────────────

  openNewEventModal(start?: Date, end?: Date) {
    const now = start || new Date();
    const later = end || new Date(now.getTime() + 60 * 60 * 1000);
    const stub: Partial<GCalEvent> = {
      summary: "",
      start: { dateTime: now.toISOString() },
      end: { dateTime: later.toISOString() },
      calendarId: this.plugin.settings.calendars.find((c) => c.enabled)?.id,
    };
    new EventModal(this.app, stub, this.plugin.settings.calendars, async (event, calId) => {
      try {
        const token = await this.getToken();
        await createEvent(token, calId, event);
        new Notice("Event created.");
        this.loadAndRender();
      } catch (err: any) {
        new Notice("Failed to create event: " + err.message);
      }
    }).open();
  }

  openEditEventModal(event: GCalEvent) {
    new EventModal(
      this.app,
      event,
      this.plugin.settings.calendars,
      async (updated, calId) => {
        try {
          const token = await this.getToken();
          await updateEvent(token, event.calendarId, event.id, updated);
          new Notice("Event updated.");
          this.loadAndRender();
        } catch (err: any) {
          new Notice("Failed to update event: " + err.message);
        }
      },
      async () => {
        try {
          const token = await this.getToken();
          await deleteEvent(token, event.calendarId, event.id);
          new Notice("Event deleted.");
          this.loadAndRender();
        } catch (err: any) {
          new Notice("Failed to delete event: " + err.message);
        }
      }
    ).open();
  }
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

class GCalSettingsTab extends PluginSettingTab {
  plugin: GCalTimeblockPlugin;

  constructor(app: App, plugin: GCalTimeblockPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "GCal Timeblock Settings" });

    // OAuth setup guide
    const guide = containerEl.createEl("details", { cls: "gcal-settings-guide" });
    guide.createEl("summary", { text: "📋 Setup Guide — How to get your credentials" });
    const guideBody = guide.createDiv({ cls: "gcal-guide-body" });
    guideBody.createEl("ol").innerHTML = `
      <li>Go to <a href="https://console.cloud.google.com/">Google Cloud Console</a></li>
      <li>Create a new project (or select existing)</li>
      <li>Enable the <strong>Google Calendar API</strong></li>
      <li>Go to <strong>APIs &amp; Services → Credentials</strong></li>
      <li>Create an <strong>OAuth 2.0 Client ID</strong> (Desktop app type)</li>
      <li>Copy your <strong>Client ID</strong> and <strong>Client Secret</strong> into the fields below</li>
      <li>Click <strong>Open Auth URL</strong>, grant access, paste the code into Step 2, click Exchange</li>
      <li>Click <strong>Load Calendars</strong> to finish</li>
    `;

    // Client ID
    new Setting(containerEl)
      .setName("Client ID")
      .setDesc("Your Google OAuth2 client ID")
      .addText((text) =>
        text
          .setPlaceholder("xxxx.apps.googleusercontent.com")
          .setValue(this.plugin.settings.clientId)
          .onChange(async (v) => {
            this.plugin.settings.clientId = v.trim();
            await this.plugin.saveSettings();
          })
      );

    // Client Secret
    new Setting(containerEl)
      .setName("Client Secret")
      .setDesc("Your Google OAuth2 client secret")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("GOCSPX-…")
          .setValue(this.plugin.settings.clientSecret)
          .onChange(async (v) => {
            this.plugin.settings.clientSecret = v.trim();
            await this.plugin.saveSettings();
          });
      });

    // Refresh token
    new Setting(containerEl)
      .setName("Refresh Token")
      .setDesc(
        "Paste your OAuth2 refresh token here, or use the button below to get one via the browser flow."
      )
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("1//0g…")
          .setValue(this.plugin.settings.refreshToken)
          .onChange(async (v) => {
            this.plugin.settings.refreshToken = v.trim();
            await this.plugin.saveSettings();
          });
      });

    // ── Step 1: Open Auth URL ──────────────────────────────────────────────────
    new Setting(containerEl)
      .setName("Step 1 — Open Google Auth")
      .setDesc("Click to open the Google consent screen in your browser. Grant access, then copy the authorisation code shown.")
      .addButton((btn) =>
        btn.setButtonText("Open Auth URL").setCta().onClick(() => {
          if (!this.plugin.settings.clientId) {
            new Notice("Enter your Client ID first.");
            return;
          }
          if (!this.plugin.settings.clientSecret) {
            new Notice("Enter your Client Secret first.");
            return;
          }
          const authUrl =
            `https://accounts.google.com/o/oauth2/v2/auth?` +
            new URLSearchParams({
              client_id: this.plugin.settings.clientId,
              redirect_uri: "urn:ietf:wg:oauth:2.0:oob",
              response_type: "code",
              scope: "https://www.googleapis.com/auth/calendar",
              access_type: "offline",
              prompt: "consent",
            }).toString();
          window.open(authUrl, "_blank");
          // Show the code input section
          codeSection.style.display = "block";
          new Notice("Browser opened — grant access, then paste the code below.", 6000);
        })
      );

    // ── Step 2: Paste auth code ────────────────────────────────────────────────
    const codeSection = containerEl.createDiv({ cls: "gcal-code-section" });
    codeSection.style.display = this.plugin.settings.refreshToken ? "none" : "block";

    let authCode = "";

    new Setting(codeSection)
      .setName("Step 2 — Paste Authorisation Code")
      .setDesc("Paste the code Google gave you after granting permission, then click Exchange.")
      .addText((text) => {
        text.setPlaceholder("4/0AX4XfWh…").onChange((v) => {
          authCode = v.trim();
        });
        text.inputEl.style.width = "260px";
      })
      .addButton((btn) =>
        btn.setButtonText("Exchange for Token").onClick(async () => {
          if (!authCode) {
            new Notice("Paste the authorisation code first.");
            return;
          }
          btn.setButtonText("Exchanging…").setDisabled(true);
          try {
            const resp = await requestUrl({
              url: "https://oauth2.googleapis.com/token",
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                client_id: this.plugin.settings.clientId,
                client_secret: this.plugin.settings.clientSecret,
                code: authCode,
                grant_type: "authorization_code",
                redirect_uri: "urn:ietf:wg:oauth:2.0:oob",
              }).toString(),
            });
            const data = resp.json;
            if (data.error) {
              throw new Error(data.error_description || data.error);
            }
            this.plugin.settings.refreshToken = data.refresh_token;
            this.plugin.settings.accessToken = data.access_token;
            this.plugin.settings.tokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
            await this.plugin.saveSettings();
            new Notice("✅ Authenticated! Now click 'Load Calendars'.", 8000);
            codeSection.style.display = "none";
            this.display(); // re-render to show the refresh token field populated
          } catch (err: any) {
            new Notice("Token exchange failed: " + err.message, 8000);
            btn.setButtonText("Exchange for Token").setDisabled(false);
          }
        })
      );

    // Load calendars
    new Setting(containerEl)
      .setName("Load Calendars")
      .setDesc("Fetch your calendar list from Google after setting up credentials.")
      .addButton((btn) =>
        btn.setButtonText("Load Calendars").onClick(async () => {
          try {
            const token = await refreshAccessToken(this.plugin.settings);
            this.plugin.settings.accessToken = token;
            this.plugin.settings.tokenExpiry = Date.now() + 3600 * 1000;
            const cals = await fetchCalendarList(token);
            // Merge — preserve enabled state
            const existing = new Map(this.plugin.settings.calendars.map((c) => [c.id, c]));
            this.plugin.settings.calendars = cals.map((c) => ({
              ...c,
              enabled: existing.get(c.id)?.enabled ?? true,
            }));
            await this.plugin.saveSettings();
            new Notice(`Loaded ${cals.length} calendars.`);
            this.display();
          } catch (err: any) {
            new Notice("Failed to load calendars: " + err.message);
          }
        })
      );

    // Calendar list
    if (this.plugin.settings.calendars.length > 0) {
      containerEl.createEl("h3", { text: "Calendars" });
      this.plugin.settings.calendars.forEach((cal, idx) => {
        const setting = new Setting(containerEl)
          .setName(cal.name)
          .setDesc(cal.id)
          .addColorPicker((cp) =>
            cp.setValue(cal.color).onChange(async (v) => {
              this.plugin.settings.calendars[idx].color = v;
              await this.plugin.saveSettings();
            })
          )
          .addToggle((toggle) =>
            toggle.setValue(cal.enabled).onChange(async (v) => {
              this.plugin.settings.calendars[idx].enabled = v;
              await this.plugin.saveSettings();
            })
          );
      });
    }

    // View settings
    containerEl.createEl("h3", { text: "View" });

    new Setting(containerEl)
      .setName("Default View")
      .addDropdown((dd) =>
        dd
          .addOption("day", "Day")
          .addOption("week", "Week")
          .setValue(this.plugin.settings.defaultView)
          .onChange(async (v) => {
            this.plugin.settings.defaultView = v as "day" | "week";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Start Hour")
      .setDesc("First hour shown in the grid (0–23)")
      .addSlider((sl) =>
        sl
          .setLimits(0, 12, 1)
          .setValue(this.plugin.settings.startHour)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.startHour = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("End Hour")
      .setDesc("Last hour shown in the grid (12–24)")
      .addSlider((sl) =>
        sl
          .setLimits(12, 24, 1)
          .setValue(this.plugin.settings.endHour)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.endHour = v;
            await this.plugin.saveSettings();
          })
      );
  }
}

// ─── Main Plugin ──────────────────────────────────────────────────────────────

export default class GCalTimeblockPlugin extends Plugin {
  settings: GCalSettings;

  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE, (leaf) => new GCalView(leaf, this));

    this.addRibbonIcon("calendar-days", "Open GCal Timeblock", () => {
      this.activateView();
    });

    this.addCommand({
      id: "open-gcal-timeblock",
      name: "Open GCal Timeblock Panel",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "gcal-today",
      name: "Go to Today",
      callback: () => {
        const view = this.getView();
        if (view) {
          view.currentDate = new Date();
          view.currentDate.setHours(0, 0, 0, 0);
          view.loadAndRender();
        }
      },
    });

    this.addSettingTab(new GCalSettingsTab(this.app, this));
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false)!;
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
    const view = leaf.view as GCalView;
    view.loadAndRender();
  }

  getView(): GCalView | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    return leaves.length > 0 ? (leaves[0].view as GCalView) : null;
  }
}
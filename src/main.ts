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
  defaultCalendarId: string;
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
  defaultCalendarId: "",
};

// ─── Google API helpers ───────────────────────────────────────────────────────

// FIX (token expiry): mutates settings in place so expiry reflects what Google
// actually returns, rather than being blindly reset on every getToken() call.
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

  // Use Google's actual expires_in rather than assuming 3600
  settings.accessToken = data.access_token;
  settings.tokenExpiry = Date.now() + (data.expires_in ?? 3600) * 1000;

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

async function moveEvent(
  token: string,
  sourceCalendarId: string,
  eventId: string,
  destinationCalendarId: string
): Promise<GCalEvent> {
  const resp = await requestUrl({
    url: `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
      sourceCalendarId
    )}/events/${eventId}/move?destination=${encodeURIComponent(destinationCalendarId)}`,
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
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

/**
 * Parse a datetime-local string (e.g. "2024-05-16T18:30") as LOCAL time.
 * new Date("2024-05-16T18:30") incorrectly parses as UTC — this avoids that.
 */
function localStringToDate(s: string): Date {
  const [datePart, timePart] = s.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute] = (timePart || "00:00").split(":").map(Number);
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

/** Returns the IANA timezone name for the current environment, e.g. "Africa/Johannesburg" */
function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
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
        this.event.start = { dateTime: localStringToDate(v).toISOString() };
      });
    });
    this.event.start = { dateTime: localStringToDate(startVal).toISOString() };

    // End time
    const endDate = this.event.end?.dateTime
      ? new Date(this.event.end.dateTime)
      : new Date(localStringToDate(startVal).getTime() + 60 * 60 * 1000);
    const endVal = toLocalISOString(endDate);

    new Setting(contentEl).setName("End").addText((text) => {
      text.inputEl.type = "datetime-local";
      text.inputEl.value = endVal;
      text.inputEl.style.width = "100%";
      text.onChange((v) => {
        this.event.end = { dateTime: localStringToDate(v).toISOString() };
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
      const tz = localTimeZone();
      if (this.event.start?.dateTime) this.event.start.timeZone = tz;
      if (this.event.end?.dateTime) this.event.end.timeZone = tz;
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

// ─── Quick Title Modal ────────────────────────────────────────────────────────

class QuickTitleModal extends Modal {
  private start: Date;
  private end: Date;
  private onConfirm: (title: string, openFull: boolean) => void;

  constructor(
    app: App,
    start: Date,
    end: Date,
    onConfirm: (title: string, openFull: boolean) => void
  ) {
    super(app);
    this.start = start;
    this.end = end;
    this.onConfirm = onConfirm;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("gcal-quick-modal");

    const fmt = (d: Date) =>
      d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    contentEl.createEl("div", {
      cls: "gcal-quick-time",
      text: `${fmt(this.start)} – ${fmt(this.end)}`,
    });

    const input = contentEl.createEl("input", {
      cls: "gcal-quick-input",
      type: "text",
      placeholder: "Event title…",
    });
    input.focus();

    const hint = contentEl.createEl("div", { cls: "gcal-quick-hint" });
    hint.innerHTML = `<kbd>Enter</kbd> to save &nbsp;·&nbsp; <kbd>Shift+Enter</kbd> for more options &nbsp;·&nbsp; <kbd>Esc</kbd> to cancel`;

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const title = input.value.trim();
        if (!title) return;
        this.close();
        this.onConfirm(title, e.shiftKey);
      }
      if (e.key === "Escape") {
        this.close();
      }
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ─── Calendar View ────────────────────────────────────────────────────────────

class GCalView extends ItemView {
  plugin: GCalTimeblockPlugin;
  currentDate: Date;
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

  // FIX (startup cache): load cached events instantly, render them, then
  // kick off a live refresh in the background and re-render when done.
  async onOpen() {
    const saved = await this.plugin.loadData();
    if (saved?.cachedEvents) {
      this.events = saved.cachedEvents;
    }
    await this.renderView();
    await this.loadAndRender();
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
    const allEvents = this.getEventsForDate(this.currentDate);
    const allDayEvents = allEvents.filter((e) => !!e.start.date && !e.start.dateTime);
    const timedEvents = allEvents.filter((e) => !!e.start.dateTime);

    // All-day strip
    if (allDayEvents.length > 0) {
      const allDayRow = container.createDiv({ cls: "gcal-allday-row" });
      allDayRow.createDiv({ cls: "gcal-allday-gutter", text: "all day" });
      const allDayCol = allDayRow.createDiv({ cls: "gcal-allday-col" });
      allDayEvents.forEach((e) => this.renderAllDayEvent(allDayCol, e));
    }

    const scrollWrap = container.createDiv({ cls: "gcal-scroll-wrap" });
    const grid = scrollWrap.createDiv({ cls: "gcal-grid" });

    // Time gutter + day column
    const timeGutter = grid.createDiv({ cls: "gcal-time-gutter" });
    const dayCol = grid.createDiv({ cls: "gcal-day-col" });
    dayCol.dataset.startHour = String(startHour);
    dayCol.dataset.day = dateKey(this.currentDate);

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

      if (h < endHour) {
        const halfLine = dayCol.createDiv({ cls: "gcal-half-line" });
        halfLine.style.top = `${y + HOUR_HEIGHT / 2}px`;
      }
    }

    // Drag-to-create
    this.attachDragCreate(dayCol, scrollWrap, startHour, this.currentDate);

    // Render events
    const positioned = this.positionEvents(timedEvents, startHour, endHour);
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
        nowLine.createDiv({ cls: "gcal-now-dot" });
      }
    }

    // Scroll to current time
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

    // All-day strip
    const hasAnyAllDay = days.some((d) =>
      this.getEventsForDate(d).some((e) => !!e.start.date && !e.start.dateTime)
    );
    if (hasAnyAllDay) {
      const allDayRow = container.createDiv({ cls: "gcal-allday-row" });
      allDayRow.createDiv({ cls: "gcal-allday-gutter", text: "all day" });
      days.forEach((day) => {
        const allDayCol = allDayRow.createDiv({ cls: "gcal-allday-col" });
        const allDayEvents = this.getEventsForDate(day).filter(
          (e) => !!e.start.date && !e.start.dateTime
        );
        allDayEvents.forEach((e) => this.renderAllDayEvent(allDayCol, e));
      });
    }

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
      dayCol.dataset.startHour = String(startHour);
      dayCol.dataset.day = dateKey(day);

      for (let h = startHour; h <= endHour; h++) {
        const y = (h - startHour) * HOUR_HEIGHT;
        const line = dayCol.createDiv({ cls: "gcal-hour-line" });
        line.style.top = `${y}px`;
        if (h < endHour) {
          const halfLine = dayCol.createDiv({ cls: "gcal-half-line" });
          halfLine.style.top = `${y + HOUR_HEIGHT / 2}px`;
        }
      }

      // Drag-to-create
      this.attachDragCreate(dayCol, scrollWrap, startHour, day);

      const timedEventsForDay = this.getEventsForDate(day).filter(
        (e) => !!e.start.dateTime
      );
      const positioned = this.positionEvents(timedEventsForDay, startHour, endHour);
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

  // ── Render all-day event chip ─────────────────────────────────────────────────

  renderAllDayEvent(col: HTMLElement, event: GCalEvent) {
    const el = col.createDiv({ cls: "gcal-allday-event" });
    el.style.backgroundColor = event.calendarColor + "33";
    el.style.borderLeftColor = event.calendarColor;
    el.setText(event.summary || "(No title)");
    el.onclick = () => this.openEditEventModal(event);
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

    // Drag to resize (bottom handle)
    if (height > 24) {
      const resizeHandle = el.createDiv({ cls: "gcal-resize-handle" });
      resizeHandle.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        let moved = false;
        const trackMove = () => { moved = true; };
        const trackUp = () => {
          document.removeEventListener("mousemove", trackMove);
          document.removeEventListener("mouseup", trackUp);
          if (moved) el.addEventListener("click", (ce) => ce.stopPropagation(), { capture: true, once: true });
        };
        document.addEventListener("mousemove", trackMove);
        document.addEventListener("mouseup", trackUp);
        this.startResize(e, event, el);
      });
    }

    // ── Drag-to-move ──────────────────────────────────────────────────────────
    el.addEventListener("mousedown", (e) => {
      if ((e.target as HTMLElement).closest(".gcal-resize-handle")) return;
      if (e.button !== 0) return;
      e.stopPropagation();

      const startX = e.clientX, startY = e.clientY;
      let dragging = false;
      let ghost: HTMLElement | null = null;
      let startLbl: HTMLElement | null = null;
      let endLbl: HTMLElement | null = null;

      const colStartHour = parseInt(col.dataset.startHour ?? "0");
      const durMs = event.end.dateTime && event.start.dateTime
        ? new Date(event.end.dateTime).getTime() - new Date(event.start.dateTime).getTime()
        : 60 * 60 * 1000;
      const durMins = durMs / 60000;

      const snap = (clientY: number, targetCol: HTMLElement): number => {
        const rect = targetCol.getBoundingClientRect();
        return Math.round(((clientY - rect.top) / HOUR_HEIGHT) * 60 / 15) * 15;
      };

      const fmt = (h: number, m: number) => {
        const ampm = h < 12 ? "AM" : "PM";
        return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${ampm}`;
      };

      const onMove = (me: MouseEvent) => {
        if (!dragging) {
          if (Math.abs(me.clientY - startY) < 4 && Math.abs(me.clientX - startX) < 4) return;
          dragging = true;
          el.classList.add("gcal-event-dragging");
          const targetCol = this.colAtPoint(me.clientX, me.clientY) ?? col;
          ghost = targetCol.createDiv({ cls: "gcal-event-ghost" });
          startLbl = targetCol.createDiv({ cls: "gcal-drag-start-label" });
          endLbl = targetCol.createDiv({ cls: "gcal-drag-end-label" });
          ghost.style.height = `${height}px`;
          ghost.style.left = el.style.left;
          ghost.style.width = el.style.width;
          ghost.style.backgroundColor = event.calendarColor + "55";
          ghost.style.borderLeftColor = event.calendarColor;
        }
        if (!ghost || !startLbl || !endLbl) return;
        const targetCol = this.colAtPoint(me.clientX, me.clientY) ?? col;
        if (ghost.parentElement !== targetCol) {
          targetCol.appendChild(ghost);
          targetCol.appendChild(startLbl);
          targetCol.appendChild(endLbl);
        }
        const sh = parseInt(targetCol.dataset.startHour ?? "0");
        const sMins = snap(me.clientY, targetCol);
        const eMins = sMins + durMins;
        const topPx = (sMins / 60) * HOUR_HEIGHT;
        ghost.style.top = `${topPx}px`;
        startLbl.style.top = `${topPx - 14}px`;
        endLbl.style.top = `${topPx + height + 2}px`;
        startLbl.setText(fmt(sh + Math.floor(sMins / 60), sMins % 60));
        endLbl.setText(fmt(sh + Math.floor(eMins / 60), eMins % 60));
      };

      const onUp = async (me: MouseEvent) => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        ghost?.remove(); ghost = null;
        startLbl?.remove(); startLbl = null;
        endLbl?.remove(); endLbl = null;
        el.classList.remove("gcal-event-dragging");

        if (!dragging) {
          this.openEditEventModal(event);
          return;
        }

        const targetCol = this.colAtPoint(me.clientX, me.clientY) ?? col;
        const sh = parseInt(targetCol.dataset.startHour ?? "0");
        const dayIso = targetCol.dataset.day ?? dateKey(this.currentDate);
        const sMins = snap(me.clientY, targetCol);
        const [y, mo, d] = dayIso.split("-").map(Number);
        const newStart = new Date(y, mo - 1, d, sh + Math.floor(sMins / 60), sMins % 60, 0, 0);
        const newEnd = new Date(newStart.getTime() + durMs);
        const tz = localTimeZone();
        try {
          const token = await this.getToken();
          await updateEvent(token, event.calendarId, event.id, {
            ...event,
            start: { dateTime: newStart.toISOString(), timeZone: tz },
            end: { dateTime: newEnd.toISOString(), timeZone: tz },
          });
          new Notice("Event moved.");
          this.loadAndRender();
        } catch (err: any) {
          new Notice("Failed to move event: " + err.message);
        }
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  startResize(e: MouseEvent, event: GCalEvent, el: HTMLElement) {
    const startY = e.clientY;
    const origHeight = el.offsetHeight;

    const onMove = (me: MouseEvent) => {
      el.style.height = `${Math.max(20, origHeight + me.clientY - startY)}px`;
    };

    const onUp = async (me: MouseEvent) => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      const newHeight = Math.max(20, origHeight + me.clientY - startY);
      const addedMins = Math.round(((newHeight - origHeight) / HOUR_HEIGHT) * 60 / 15) * 15;
      if (!event.end.dateTime) return;
      const newEnd = new Date(new Date(event.end.dateTime).getTime() + addedMins * 60 * 1000);
      const tz = localTimeZone();
      try {
        const token = await this.getToken();
        await updateEvent(token, event.calendarId, event.id, {
          ...event,
          end: { dateTime: newEnd.toISOString(), timeZone: tz },
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

  private colAtPoint(x: number, y: number): HTMLElement | null {
    const els = Array.from(document.elementsFromPoint(x, y)) as HTMLElement[];
    return els.find(el => el.classList.contains("gcal-day-col")) ?? null;
  }

  // ── Event helpers ─────────────────────────────────────────────────────────────

  getEventsForDate(date: Date): GCalEvent[] {
    const key = dateKey(date);
    return this.events.filter((e) => {
      if (e.start.dateTime) {
        return dateKey(new Date(e.start.dateTime)) === key;
      }
      if (e.start.date && e.end.date) {
        // All-day: start is inclusive, end is exclusive (Google Calendar convention)
        return key >= e.start.date && key < e.end.date;
      }
      if (e.start.date) {
        return e.start.date === key;
      }
      return false;
    });
  }

  // FIX (token expiry): delegate expiry tracking entirely to refreshAccessToken,
  // which now mutates settings in place with the real expires_in value.
  async getToken(): Promise<string> {
    await refreshAccessToken(this.plugin.settings);
    await this.plugin.saveSettings();
    return this.plugin.settings.accessToken;
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

      // FIX (startup cache): persist fetched events so they're available
      // immediately on the next startup before the network responds.
      const saved = await this.plugin.loadData() ?? {};
      await this.plugin.saveData({ ...saved, cachedEvents: allEvents });

    } catch (err: any) {
      new Notice("Failed to load events: " + err.message);
    }

    this.loading = false;
    await this.renderView();
  }

  // ── Drag-to-create ────────────────────────────────────────────────────────────

  attachDragCreate(col: HTMLElement, scrollWrap: HTMLElement, startHour: number, day: Date) {
    let dragEl: HTMLElement | null = null;
    let dragStartY = 0;
    let dragStartMins = 0;

    // FIX (drag scroll): getBoundingClientRect().top is already viewport-relative
    // and naturally reflects scroll position, so adding scrollTop double-counts it.
    // Remove scrollTop — the coordinate is correct without it.
    const yToMins = (clientY: number): number => {
      const rect = col.getBoundingClientRect();
      const relY = clientY - rect.top;
      const rawMins = (relY / HOUR_HEIGHT) * 60;
      return Math.round(rawMins / 15) * 15;
    };

    const minsToTop = (mins: number): number => (mins / 60) * HOUR_HEIGHT;

    col.addEventListener("mousedown", (e) => {
      if ((e.target as HTMLElement).closest(".gcal-event,.gcal-resize-handle")) return;
      if (e.button !== 0) return;

      e.preventDefault();
      dragStartY = e.clientY;
      dragStartMins = yToMins(e.clientY);

      dragEl = col.createDiv({ cls: "gcal-drag-ghost" });
      dragEl.style.top = `${minsToTop(dragStartMins)}px`;
      dragEl.style.height = `${minsToTop(60)}px`; // start at 1hr

      const startLabel = col.createDiv({ cls: "gcal-drag-start-label" });
      const endLabel = col.createDiv({ cls: "gcal-drag-end-label" });
      const durationPill = dragEl.createDiv({ cls: "gcal-drag-duration" });
      dragEl.createDiv({ cls: "gcal-drag-title", text: "New event" });

      const fmt = (h: number, m: number) => {
        const ampm = h < 12 ? "AM" : "PM";
        const h12 = h % 12 || 12;
        return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
      };

      const updateGhost = (currentMins: number) => {
        const startMins = Math.min(dragStartMins, currentMins);
        const endMins = Math.max(dragStartMins + 15, currentMins);
        const topPx = minsToTop(startMins);
        const heightPx = minsToTop(endMins - startMins);

        dragEl!.style.top = `${topPx}px`;
        dragEl!.style.height = `${heightPx}px`;

        const sH = startHour + Math.floor(startMins / 60);
        const sM = startMins % 60;
        const eH = startHour + Math.floor(endMins / 60);
        const eM = endMins % 60;

        startLabel.style.top = `${topPx - 14}px`;
        startLabel.setText(fmt(sH, sM));
        endLabel.style.top = `${topPx + heightPx + 2}px`;
        endLabel.setText(fmt(eH, eM));

        const durMins = endMins - startMins;
        const durH = Math.floor(durMins / 60);
        const durM = durMins % 60;
        durationPill.setText(
          durH > 0 && durM > 0 ? `${durH}h ${durM}m` :
          durH > 0 ? `${durH}h` : `${durM}m`
        );
      };

      updateGhost(dragStartMins + 60); // initialise at 1 hour

      const onMove = (me: MouseEvent) => {
        if (!dragEl) return;
        updateGhost(yToMins(me.clientY));
      };

      const onUp = (me: MouseEvent) => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);

        if (!dragEl) return;
        dragEl.remove();
        dragEl = null;
        startLabel.remove();
        endLabel.remove();

        const currentMins = yToMins(me.clientY);
        const startMins = Math.min(dragStartMins, currentMins);
        const endMins = Math.max(dragStartMins + 15, currentMins);

        // If barely moved (< 5px), treat as a plain click → full modal
        if (Math.abs(me.clientY - dragStartY) < 5) {
          const start = new Date(day);
          start.setHours(startHour + Math.floor(startMins / 60), startMins % 60, 0, 0);
          const end = new Date(start.getTime() + 60 * 60 * 1000);
          this.openNewEventModal(start, end);
          return;
        }

        // Drag completed — show quick-title modal
        const start = new Date(day);
        start.setHours(startHour + Math.floor(startMins / 60), startMins % 60, 0, 0);
        const end = new Date(day);
        end.setHours(startHour + Math.floor(endMins / 60), endMins % 60, 0, 0);

        new QuickTitleModal(this.app, start, end, async (title, openFull) => {
          const defaultCalId =
            this.plugin.settings.defaultCalendarId ||
            this.plugin.settings.calendars.find((c) => c.enabled)?.id || "";

          const calColor =
            this.plugin.settings.calendars.find((c) => c.id === defaultCalId)?.color || "#4285F4";
          const tz = localTimeZone();

          if (openFull) {
            const stub: Partial<GCalEvent> = {
              summary: title,
              start: { dateTime: start.toISOString(), timeZone: tz },
              end: { dateTime: end.toISOString(), timeZone: tz },
              calendarId: defaultCalId,
              calendarColor: calColor,
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
          } else {
            try {
              const token = await this.getToken();
              await createEvent(token, defaultCalId, {
                summary: title,
                start: { dateTime: start.toISOString(), timeZone: tz },
                end: { dateTime: end.toISOString(), timeZone: tz },
              });
              new Notice("Event created.");
              this.loadAndRender();
            } catch (err: any) {
              new Notice("Failed to create event: " + err.message);
            }
          }
        }).open();
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  // ── Modals ────────────────────────────────────────────────────────────────────

  openNewEventModal(start?: Date, end?: Date) {
    const now = start || new Date();
    const later = end || new Date(now.getTime() + 60 * 60 * 1000);
    const defaultCalId =
      this.plugin.settings.defaultCalendarId ||
      this.plugin.settings.calendars.find((c) => c.enabled)?.id;
    const stub: Partial<GCalEvent> = {
      summary: "",
      start: { dateTime: now.toISOString() },
      end: { dateTime: later.toISOString() },
      calendarId: defaultCalId,
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

  // FIX (calendar change): use the events.move API when the user picks a
  // different calendar, then update the event content on the new calendar.
  // Previously calId was ignored and the PUT always targeted event.calendarId.
  openEditEventModal(event: GCalEvent) {
    new EventModal(
      this.app,
      event,
      this.plugin.settings.calendars,
      async (updated, calId) => {
        try {
          const token = await this.getToken();
          if (calId && calId !== event.calendarId) {
            // Move to the new calendar first, then update content
            await moveEvent(token, event.calendarId, event.id, calId);
            await updateEvent(token, calId, event.id, updated);
          } else {
            await updateEvent(token, event.calendarId, event.id, updated);
          }
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
        new Setting(containerEl)
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
      .setName("Default Calendar")
      .setDesc("Calendar used when creating events by dragging or via quick-add.")
      .addDropdown((dd) => {
        dd.addOption("", "— first enabled calendar —");
        this.plugin.settings.calendars
          .filter((c) => c.enabled)
          .forEach((c) => dd.addOption(c.id, c.name));
        dd.setValue(this.plugin.settings.defaultCalendarId || "");
        dd.onChange(async (v) => {
          this.plugin.settings.defaultCalendarId = v;
          await this.plugin.saveSettings();
        });
      });

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
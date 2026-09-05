const { createApp, nextTick } = Vue;

const APP_VERSION = readCurrentAppVersion();
const ROSTER_CACHE_KEY = "schedulePhotoReader.roster.v1";
const PROFILE_CACHE_KEY = "schedulePhotoReader.profile.v1";
const NAME_CACHE_KEY = "schedulePhotoReader.nameAliases.v1";
const EVENT_CACHE_KEY = "schedulePhotoReader.dateEvents.v1";
const VERSION_REFRESH_CACHE_KEY = "schedulePhotoReader.versionRefresh.v1";
const VERSION_CHECK_MIN_INTERVAL_MS = 30000;
const DAY_TRANSITION_MS = 260;
const DAY_FAST_TRANSITION_MS = 36;
const DAY_FAST_FRAME_GAP_MS = 6;
const DAY_FAST_MAX_HOPS = 6;
const SHIFT_PANDA_IMAGES = Object.freeze({
  work: "assets/shift-panda-work.png",
  late: "assets/shift-panda-late.png",
  off: "assets/shift-panda-off.png",
});
const VALID_SHIFT_CONTEXTS = new Set(["TR", "CDT", "CON"]);
const SHIFT_EDITOR_HOURS = Object.freeze(Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, "0")));
const SHIFT_EDITOR_MINUTES = Object.freeze(["00", "30"]);
const SHIFT_CONTEXT_MAX_LENGTH = 24;

createApp({
  data() {
    return {
      selectedFile: null,
      previewUrl: "",
      isDragging: false,
      isProcessing: false,
      isSharing: false,
      progress: 0,
      statusText: "Upload Photo",
      table: [],
      cellReviewHints: {},
      rosterDb: null,
      selectedProfileId: "",
      profilePickerIndex: 0,
      profileSwipeX: null,
      profileSwipeY: null,
      profileDragOffset: 0,
      profileIsDragging: false,
      profileTransitionDirection: "",
      profileTransitionTimer: null,
      selectedShiftIndex: 0,
      daySwipeX: null,
      daySwipeY: null,
      dayDragOffset: 0,
      dayIsDragging: false,
      dayIsFastTraveling: false,
      dayFastTravelTargetIndex: null,
      dayFastTravelStepSize: 1,
      dayFastTravelTimer: null,
      dayTransitionDirection: "",
      dayTransitionTimer: null,
      daySuppressClick: false,
      daySuppressClickTimer: null,
      coworkerModalShift: null,
      nameAliases: {},
      nameEditorProfile: null,
      nameEditorValue: "",
      dateEvents: {},
      eventEditorShift: null,
      eventEditorValue: "",
      shiftEditorShift: null,
      shiftEditorValue: "",
      shiftEditorMode: "work",
      shiftEditorIsAl: false,
      shiftEditorHour: "09",
      shiftEditorMinute: "00",
      shiftEditorContext: "",
      shiftWheelScrollTimer: null,
      showSpreadsheet: false,
      pendingReplace: false,
      readError: false,
      runId: 0,
      serverAuth: "not configured",
      googleApiKey: "",
      lastVersionCheckAt: 0,
      isRefreshingForVersion: false,
      versionWakeHandlers: null,
    };
  },
  computed: {
    showUploadScreen() {
      return this.pendingReplace || (!this.hasDatabase && !this.selectedFile);
    },
    showStatusPanel() {
      return Boolean(this.selectedFile && (this.isProcessing || !this.hasDatabase || this.readError));
    },
    hasDatabase() {
      return Array.isArray(this.rosterDb?.profiles) && this.rosterDb.profiles.length > 0;
    },
    profiles() {
      return this.rosterDb?.profiles || [];
    },
    selectedProfile() {
      if (!this.selectedProfileId) return null;
      return this.profiles.find((profile) => profile.id === this.selectedProfileId) || null;
    },
    pickerProfile() {
      if (!this.profiles.length) return null;
      return this.profiles[this.profilePickerIndex] || this.profiles[0];
    },
    profileCarouselItems() {
      const count = this.profiles.length;
      if (!count) return [];

      const activeIndex = clampIndex(this.profilePickerIndex, count);
      const items = [
        {
          slot: "active",
          profile: this.profiles[activeIndex],
        },
      ];

      if (count > 1) {
        items.unshift({
          slot: "previous",
          profile: this.profiles[clampIndex(activeIndex - 1, count)],
        });
        items.push({
          slot: "next",
          profile: this.profiles[clampIndex(activeIndex + 1, count)],
        });
      }

      return items;
    },
    profileStageClass() {
      return {
        "is-dragging": this.profileIsDragging,
        "slide-next": this.profileTransitionDirection === "next",
        "slide-previous": this.profileTransitionDirection === "previous",
      };
    },
    profileStageStyle() {
      const offset = Math.max(-96, Math.min(96, this.profileDragOffset));
      return {
        "--drag-offset": `${offset}px`,
      };
    },
    rosterMonthLabel() {
      if (!this.rosterDb) return "";
      return [this.rosterDb.monthLabel, this.rosterDb.year].filter(Boolean).join(" ");
    },
    todayShift() {
      if (!this.selectedProfile) return null;
      return this.selectedProfile.shifts.find((shift) => shift.dateKey === this.todayDateKey) || null;
    },
    todayDateKey() {
      return formatDateKey(new Date());
    },
    activeShift() {
      const shifts = this.selectedProfile?.shifts || [];
      if (!shifts.length) return null;
      return shifts[clampIndex(this.selectedShiftIndex, shifts.length)] || shifts[0];
    },
    activeShiftTitle() {
      if (!this.activeShift) return "No shift";
      return `${this.shiftRelativeLabel(this.activeShift)} · ${this.displayShift(this.activeShift.value)}`;
    },
    coworkerModalWorkers() {
      return this.otherWorkingProfiles(this.coworkerModalShift);
    },
    coworkerModalTitle() {
      if (!this.coworkerModalShift) return "";
      return [this.shiftRelativeLabel(this.coworkerModalShift), this.coworkerModalShift.dateLabel]
        .filter(Boolean)
        .join(" - ");
    },
    eventEditorTitle() {
      if (!this.eventEditorShift) return "";
      return [this.shiftRelativeLabel(this.eventEditorShift), this.eventEditorShift.dateLabel]
        .filter(Boolean)
        .join(" - ");
    },
    shiftEditorTitle() {
      if (!this.shiftEditorShift) return "";
      return [this.shiftRelativeLabel(this.shiftEditorShift), this.shiftEditorShift.dateLabel]
        .filter(Boolean)
        .join(" - ");
    },
    shiftEditorHours() {
      return SHIFT_EDITOR_HOURS;
    },
    shiftEditorMinutes() {
      return SHIFT_EDITOR_MINUTES;
    },
    shiftEditorPreview() {
      return buildShiftEditorValue({
        mode: this.shiftEditorMode,
        isAl: this.shiftEditorIsAl,
        hour: this.shiftEditorHour,
        minute: this.shiftEditorMinute,
        context: this.shiftEditorContext,
      });
    },
    dayCarouselItems() {
      const shifts = this.selectedProfile?.shifts || [];
      const count = shifts.length;
      if (!count) return [];

      const activeIndex = clampIndex(this.selectedShiftIndex, count);
      const activeItem = {
        slot: "active",
        shift: shifts[activeIndex],
      };

      if (count === 1) return [activeItem];

      let previousStep = 1;
      let nextStep = 1;
      let previousIndex = clampIndex(activeIndex - previousStep, count);
      let nextIndex = clampIndex(activeIndex + nextStep, count);
      let previousFarIndex = clampIndex(activeIndex - previousStep * 2, count);
      let nextFarIndex = clampIndex(activeIndex + nextStep * 2, count);

      if (this.dayIsFastTraveling && Number.isInteger(this.dayFastTravelTargetIndex)) {
        const targetIndex = Math.max(0, Math.min(this.dayFastTravelTargetIndex, count - 1));
        const stepSize = Math.max(1, this.dayFastTravelStepSize || 1);

        if (targetIndex > activeIndex) {
          nextStep = stepSize;
          previousStep = stepSize;
          nextIndex = Math.min(targetIndex, activeIndex + nextStep);
          nextFarIndex = Math.min(targetIndex, nextIndex + nextStep);
          previousIndex = activeIndex > 0 ? Math.max(0, activeIndex - previousStep) : previousIndex;
          previousFarIndex = activeIndex > 0 ? Math.max(0, previousIndex - previousStep) : previousFarIndex;
        } else if (targetIndex < activeIndex) {
          previousStep = stepSize;
          nextStep = stepSize;
          previousIndex = Math.max(targetIndex, activeIndex - previousStep);
          previousFarIndex = Math.max(targetIndex, previousIndex - previousStep);
          nextIndex = activeIndex < count - 1 ? Math.min(count - 1, activeIndex + nextStep) : nextIndex;
          nextFarIndex = activeIndex < count - 1 ? Math.min(count - 1, nextIndex + nextStep) : nextFarIndex;
        }
      }

      const items = [
        {
          slot: "previous",
          shift: shifts[previousIndex],
        },
        activeItem,
        {
          slot: "next",
          shift: shifts[nextIndex],
        },
      ];

      if (count > 2) {
        items.unshift({
          slot: "previous-far",
          shift: shifts[previousFarIndex],
        });
        items.push({
          slot: "next-far",
          shift: shifts[nextFarIndex],
        });
      }

      return items;
    },
    dayStageClass() {
      return {
        "is-dragging": this.dayIsDragging,
        "is-fast-traveling": this.dayIsFastTraveling,
        "slide-next": this.dayTransitionDirection === "next",
        "slide-previous": this.dayTransitionDirection === "previous",
      };
    },
    dayStageStyle() {
      const offset = Math.max(-110, Math.min(110, this.dayDragOffset));
      return {
        "--drag-offset": `${offset}px`,
      };
    },
    hasTable() {
      return this.table.length > 0 && this.columnCount > 0;
    },
    columnCount() {
      return this.table.reduce((max, row) => Math.max(max, row.length), 0);
    },
    normalizedTable() {
      return this.table;
    },
    reviewHintCount() {
      return Object.keys(this.cellReviewHints).length;
    },
    hasGoogleAuth() {
      return this.serverAuth !== "not configured" || Boolean(this.googleApiKey.trim());
    },
    needsCredential() {
      return this.serverAuth === "not configured" && !this.googleApiKey.trim();
    },
    fileSize() {
      if (!this.selectedFile) return "";
      const units = ["B", "KB", "MB", "GB"];
      let size = this.selectedFile.size;
      let unitIndex = 0;

      while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex += 1;
      }

      const value = unitIndex === 0 ? size : size.toFixed(size >= 10 ? 1 : 2);
      return `${value} ${units[unitIndex]}`;
    },
  },
  mounted() {
    this.restoreNameAliases();
    this.restoreDateEvents();
    this.restoreCachedRoster();
    this.checkHealth();
    this.bindVersionWakeChecks();
    this.checkAppVersion({ force: true });
    this.refreshIcons();
  },
  updated() {
    this.refreshIcons();
  },
  beforeUnmount() {
    this.revokePreview();
    window.clearTimeout(this.profileTransitionTimer);
    window.clearTimeout(this.dayTransitionTimer);
    window.clearTimeout(this.dayFastTravelTimer);
    window.clearTimeout(this.shiftWheelScrollTimer);
    this.unbindVersionWakeChecks();
  },
  methods: {
    bindVersionWakeChecks() {
      if (this.versionWakeHandlers) return;

      this.versionWakeHandlers = {
        visibility: () => {
          if (document.visibilityState === "visible") {
            this.checkAppVersion({ force: true });
          }
        },
        focus: () => this.checkAppVersion(),
        pageshow: (event) => this.checkAppVersion({ force: Boolean(event.persisted) }),
      };

      document.addEventListener("visibilitychange", this.versionWakeHandlers.visibility);
      window.addEventListener("focus", this.versionWakeHandlers.focus);
      window.addEventListener("pageshow", this.versionWakeHandlers.pageshow);
    },
    unbindVersionWakeChecks() {
      if (!this.versionWakeHandlers) return;

      document.removeEventListener("visibilitychange", this.versionWakeHandlers.visibility);
      window.removeEventListener("focus", this.versionWakeHandlers.focus);
      window.removeEventListener("pageshow", this.versionWakeHandlers.pageshow);
      this.versionWakeHandlers = null;
    },
    async checkAppVersion(options = {}) {
      if (this.isRefreshingForVersion) return;

      const now = Date.now();
      if (!options.force && now - this.lastVersionCheckAt < VERSION_CHECK_MIN_INTERVAL_MS) return;
      this.lastVersionCheckAt = now;

      try {
        const response = await fetch(`/api/version?local=${APP_VERSION}&t=${now}`, {
          cache: "no-store",
          headers: {
            "Cache-Control": "no-cache",
          },
        });
        if (!response.ok) return;

        const result = await response.json();
        const remoteVersion = Number(result.version);
        if (!Number.isFinite(remoteVersion)) return;

        if (remoteVersion === APP_VERSION) {
          window.sessionStorage.removeItem(VERSION_REFRESH_CACHE_KEY);
          return;
        }

        this.forceVersionRefresh(remoteVersion);
      } catch (error) {
        console.info("App version check skipped", error);
      }
    },
    forceVersionRefresh(remoteVersion) {
      const version = String(remoteVersion);
      const lastRefresh = window.sessionStorage.getItem(VERSION_REFRESH_CACHE_KEY);
      if (lastRefresh === version) return;

      window.sessionStorage.setItem(VERSION_REFRESH_CACHE_KEY, version);
      this.isRefreshingForVersion = true;

      const url = new URL(window.location.href);
      url.searchParams.set("appVersion", version);
      url.searchParams.set("refresh", String(Date.now()));
      window.location.replace(url.toString());
    },
    openPicker() {
      this.$refs.fileInput.click();
    },
    replacePhoto() {
      this.pendingReplace = true;
      this.readError = false;
      this.showSpreadsheet = false;
      this.closeCoworkerModal();
      this.closeNameEditor();
      this.closeDateEventEditor();
      this.closeShiftEditor();
      nextTick(() => this.refreshIcons());
    },
    returnToSchedule() {
      this.pendingReplace = false;
      this.readError = false;
      nextTick(() => this.refreshIcons());
    },
    handleFileSelect(event) {
      const [file] = event.target.files;
      if (!file) {
        return;
      }

      this.useFile(file);
      event.target.value = "";
    },
    handleDrop(event) {
      this.setDragging(false);
      const [file] = event.dataTransfer.files;
      this.useFile(file);
    },
    setDragging(value) {
      this.isDragging = value;
    },
    useFile(file) {
      if (!isImageFile(file)) {
        this.statusText = "Upload an image file";
        return;
      }

      this.revokePreview();
      this.selectedFile = file;
      this.previewUrl = URL.createObjectURL(file);
      this.progress = 0;
      this.isProcessing = false;
      this.readError = false;
      this.showSpreadsheet = false;
      this.statusText = "Reading photo...";
      this.runId += 1;
      this.pendingReplace = false;

      nextTick(() => {
        this.refreshIcons();
        this.readPhoto();
      });
    },
    async readPhoto() {
      if (!this.previewUrl || this.isProcessing) return;

      const activeRun = this.runId;
      this.isProcessing = true;
      this.progress = 4;
      this.readError = false;
      this.showSpreadsheet = false;
      this.statusText = "Detecting table grid...";

      try {
        await this.checkHealth();
        if (!this.hasGoogleAuth) {
          this.statusText = "Google Vision key is not configured";
          this.progress = 0;
          this.readError = true;
          return;
        }

        const image = await loadImage(this.previewUrl);
        if (activeRun !== this.runId) return;

        const imageCanvas = makeImageCanvas(image);
        const grid = detectTableGrid(imageCanvas);
        this.progress = 18;

        this.statusText = "Cleaning image for OCR...";
        const ocrImage = preprocessImageForOcr(imageCanvas);
        const ocrGrid = scaleGrid(grid, ocrImage.scale);
        const imageBase64 = ocrImage.base64;
        this.progress = 32;
        if (activeRun !== this.runId) return;

        this.statusText = "Calling Google Vision...";
        const response = await fetch("/api/vision", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            imageBase64,
            fileName: this.selectedFile.name,
            mimeType: ocrImage.mimeType,
            googleApiKey: this.googleApiKey.trim() || undefined,
          }),
        });

        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(result.error || `Google Vision failed (${response.status})`);
        }

        if (activeRun !== this.runId) return;

        this.progress = 82;
        this.statusText = "Building roster...";

        const mappedTable = grid.isUsable ? wordsToTable(result.words || [], ocrGrid) : [];
        const fallbackTable = textToTable(result.text || "");
        const useMappedTable =
          countFilledCells(mappedTable) >= Math.max(8, countFilledCells(fallbackTable) * 0.35);
        const bestTable = useMappedTable ? mappedTable : fallbackTable;
        const trimmedTable = trimEmptyEdgesWithMap(bestTable);
        const reviewedOcr = prepareOcrTableForSchedule(padRows(trimmedTable.table), {
          imageCanvas,
          grid: useMappedTable && grid.isUsable ? grid : null,
          rowMap: trimmedTable.rowMap,
        });

        this.table = reviewedOcr.table;
        this.cellReviewHints = reviewedOcr.reviewHints;
        const rosterDb = createRosterDatabase(this.table, this.selectedFile.name, this.cellReviewHints);

        if (!rosterDb.profiles.length) {
          this.showSpreadsheet = true;
          this.statusText = "Spreadsheet ready, but no worker profiles were found";
          this.progress = 100;
          return;
        }

        this.setRosterDb(rosterDb);
        this.progress = 100;
        this.statusText = this.reviewHintCount
          ? `Roster saved with ${rosterDb.profiles.length} profiles; ${this.reviewHintCount} cells need review`
          : `Roster saved with ${rosterDb.profiles.length} profiles`;
      } catch (error) {
        console.error(error);
        this.statusText = error.message || "Could not read this photo";
        this.progress = 0;
        this.readError = true;
      } finally {
        if (activeRun === this.runId) {
          this.isProcessing = false;
        }
      }
    },
    async checkHealth() {
      try {
        const response = await fetch("/api/health");
        const result = await response.json();
        this.serverAuth = result.googleAuth || "not configured";
      } catch {
        this.serverAuth = "not configured";
      }
    },
    saveTableAsDatabase() {
      if (!this.hasTable) return;

      const sourceName = this.selectedFile?.name || this.rosterDb?.sourceFileName || "spreadsheet";
      this.cellReviewHints = pruneReviewHintsForTable(this.cellReviewHints, this.table);
      const rosterDb = createRosterDatabase(this.table, sourceName, this.cellReviewHints);
      if (!rosterDb.profiles.length) {
        this.statusText = "No worker profiles were found in column A";
        return;
      }

      this.setRosterDb(rosterDb);
      this.showSpreadsheet = false;
      this.statusText = `Roster saved with ${rosterDb.profiles.length} profiles`;
    },
    setRosterDb(rosterDb) {
      this.rosterDb = rosterDb;
      this.table = padRows(rosterDb.rawTable || this.table);
      this.cellReviewHints = normalizeReviewHints(rosterDb.reviewHints);
      this.readError = false;
      writeCache(ROSTER_CACHE_KEY, rosterDb);

      const cachedProfileId = readTextCache(PROFILE_CACHE_KEY);
      const nextProfileId = this.profileExists(this.selectedProfileId)
        ? this.selectedProfileId
        : cachedProfileId;

      this.selectedProfileId = this.profileExists(nextProfileId) ? nextProfileId : "";
      this.profilePickerIndex = this.selectedProfileId
        ? Math.max(0, this.profiles.findIndex((profile) => profile.id === this.selectedProfileId))
        : 0;
      this.syncSelectedShiftIndex();
      this.showSpreadsheet = false;
    },
    restoreCachedRoster() {
      const rosterDb = readCache(ROSTER_CACHE_KEY);
      if (!isValidRosterDatabase(rosterDb)) return;

      this.rosterDb = rosterDb;
      this.table = padRows(rosterDb.rawTable || []);
      this.cellReviewHints = normalizeReviewHints(rosterDb.reviewHints);

      const cachedProfileId = readTextCache(PROFILE_CACHE_KEY);
      this.selectedProfileId = this.profileExists(cachedProfileId) ? cachedProfileId : "";
      this.profilePickerIndex = this.selectedProfileId
        ? Math.max(0, this.profiles.findIndex((profile) => profile.id === this.selectedProfileId))
        : 0;
      this.syncSelectedShiftIndex();
      this.statusText = "Roster loaded from cache";
    },
    selectPickerProfile() {
      if (!this.pickerProfile || this.profileTransitionDirection) return;
      this.selectProfile(this.pickerProfile.id);
    },
    selectProfile(profileId) {
      if (!this.profileExists(profileId)) return;
      this.selectedProfileId = profileId;
      writeTextCache(PROFILE_CACHE_KEY, profileId);
      this.syncSelectedShiftIndex();
    },
    pickProfileIndex(profileId) {
      const index = this.profiles.findIndex((profile) => profile.id === profileId);
      if (index < 0) return;
      this.profilePickerIndex = index;
    },
    previousProfile() {
      this.animateProfile("previous");
    },
    nextProfile() {
      this.animateProfile("next");
    },
    animateProfile(direction) {
      if (this.profiles.length <= 1 || this.profileTransitionDirection) return;

      this.profileIsDragging = false;
      this.profileDragOffset = 0;
      this.profileTransitionDirection = direction;
      window.clearTimeout(this.profileTransitionTimer);
      this.profileTransitionTimer = window.setTimeout(() => {
        const delta = direction === "next" ? 1 : -1;
        this.profilePickerIndex = clampIndex(this.profilePickerIndex + delta, this.profiles.length);
        this.profileTransitionDirection = "";
        this.profileTransitionTimer = null;
      }, 260);
    },
    handleProfileCardClick(slot) {
      if (this.profileIsDragging || this.profileTransitionDirection) return;
      if (slot === "previous") this.previousProfile();
      if (slot === "next") this.nextProfile();
    },
    startProfileSwipe(event) {
      if (this.profileTransitionDirection) return;
      this.profileSwipeX = Number(event.clientX);
      this.profileSwipeY = Number(event.clientY);
      this.profileDragOffset = 0;
      this.profileIsDragging = true;
      event.currentTarget?.setPointerCapture?.(event.pointerId);
    },
    moveProfileSwipe(event) {
      if (this.profileSwipeX === null || this.profileTransitionDirection) return;

      const distance = Number(event.clientX) - this.profileSwipeX;
      const verticalDistance = Math.abs(Number(event.clientY) - this.profileSwipeY);
      if (Math.abs(distance) < verticalDistance) return;

      this.profileDragOffset = distance * 0.62;
    },
    finishProfileSwipe(event) {
      if (this.profileSwipeX === null) return;
      const distance = Number(event.clientX) - this.profileSwipeX;
      const verticalDistance = Math.abs(Number(event.clientY) - this.profileSwipeY);
      this.profileSwipeX = null;
      this.profileSwipeY = null;
      this.profileIsDragging = false;
      this.profileDragOffset = 0;
      event.currentTarget?.releasePointerCapture?.(event.pointerId);

      if (Math.abs(distance) < 42 || Math.abs(distance) < verticalDistance) return;
      if (distance > 0) {
        this.previousProfile();
      } else {
        this.nextProfile();
      }
    },
    cancelProfileSwipe() {
      this.profileSwipeX = null;
      this.profileSwipeY = null;
      this.profileDragOffset = 0;
      this.profileIsDragging = false;
    },
    changeProfile() {
      this.closeCoworkerModal();
      this.closeDateEventEditor();
      this.closeShiftEditor();
      this.selectedProfileId = "";
      this.selectedShiftIndex = 0;
      removeCache(PROFILE_CACHE_KEY);
    },
    clearCache() {
      this.runId += 1;
      this.clearCachedRosterOnly();
      this.revokePreview();
      this.selectedFile = null;
      this.previewUrl = "";
      this.table = [];
      this.cellReviewHints = {};
      this.progress = 0;
      this.isProcessing = false;
      this.readError = false;
      this.showSpreadsheet = false;
      this.pendingReplace = false;
      this.dateEvents = {};
      this.eventEditorShift = null;
      this.eventEditorValue = "";
      this.shiftEditorShift = null;
      this.shiftEditorValue = "";
      removeCache(EVENT_CACHE_KEY);
      this.statusText = "Upload Photo";
    },
    clearCachedRosterOnly() {
      removeCache(ROSTER_CACHE_KEY);
      removeCache(PROFILE_CACHE_KEY);
      this.rosterDb = null;
      this.cellReviewHints = {};
      this.selectedProfileId = "";
      this.profilePickerIndex = 0;
      this.selectedShiftIndex = 0;
      this.coworkerModalShift = null;
      this.eventEditorShift = null;
      this.shiftEditorShift = null;
      this.shiftEditorValue = "";
    },
    restoreDateEvents() {
      const events = readCache(EVENT_CACHE_KEY);
      if (!events || typeof events !== "object" || Array.isArray(events)) {
        this.dateEvents = {};
        return;
      }

      this.dateEvents = Object.fromEntries(
        Object.entries(events)
          .map(([key, value]) => [key, normalizeEventText(value)])
          .filter(([key, value]) => key && value)
      );
    },
    shiftEventText(shift) {
      const key = shiftEventKey(shift);
      return key ? this.dateEvents[key] || "" : "";
    },
    eventActionLabel(shift) {
      return this.shiftEventText(shift) ? "Edit Event" : "Add Event";
    },
    openDateEventEditor(shift = this.activeShift) {
      if (!shiftEventKey(shift)) return;
      this.closeCoworkerModal();
      this.closeNameEditor();
      this.closeShiftEditor();
      this.eventEditorShift = shift;
      this.eventEditorValue = this.shiftEventText(shift);
      nextTick(() => {
        this.refreshIcons();
        this.$refs.eventEditorInput?.focus?.();
        this.$refs.eventEditorInput?.select?.();
      });
    },
    closeDateEventEditor() {
      this.eventEditorShift = null;
      this.eventEditorValue = "";
    },
    openShiftEditor(shift = this.activeShift) {
      if (!shift || !this.selectedProfile) return;
      this.closeCoworkerModal();
      this.closeDateEventEditor();
      this.closeNameEditor();
      const editorState = shiftValueToEditorState(shift.value);
      this.shiftEditorShift = shift;
      this.shiftEditorValue = String(shift.value || "");
      this.shiftEditorMode = editorState.mode;
      this.shiftEditorIsAl = editorState.isAl;
      this.shiftEditorHour = editorState.hour;
      this.shiftEditorMinute = editorState.minute;
      this.shiftEditorContext = editorState.context;
      nextTick(() => {
        this.refreshIcons();
        this.syncShiftWheelScroll();
      });
    },
    closeShiftEditor() {
      this.shiftEditorShift = null;
      this.shiftEditorValue = "";
      this.shiftEditorMode = "work";
      this.shiftEditorIsAl = false;
      this.shiftEditorHour = "09";
      this.shiftEditorMinute = "00";
      this.shiftEditorContext = "";
    },
    setShiftEditorMode(mode) {
      this.shiftEditorMode = mode === "off" ? "off" : "work";
      nextTick(() => this.syncShiftWheelScroll());
    },
    setShiftEditorAl(value) {
      this.shiftEditorIsAl = Boolean(value);
    },
    setShiftEditorTime(part, value) {
      const text = String(value || "").padStart(2, "0");
      if (part === "hour" && SHIFT_EDITOR_HOURS.includes(text)) {
        this.shiftEditorHour = text;
      }
      if (part === "minute" && SHIFT_EDITOR_MINUTES.includes(text)) {
        this.shiftEditorMinute = text;
      }
      nextTick(() => this.syncShiftWheelScroll());
    },
    syncShiftWheelScroll() {
      document
        .querySelectorAll(".shift-time-wheel .active")
        .forEach((button) => button.scrollIntoView({ block: "center", inline: "nearest" }));
    },
    handleShiftWheelScroll(part, event) {
      const container = event.currentTarget;
      window.clearTimeout(this.shiftWheelScrollTimer);
      this.shiftWheelScrollTimer = window.setTimeout(() => {
        const center = container.getBoundingClientRect().top + container.clientHeight / 2;
        const buttons = [...container.querySelectorAll("[data-value]")];
        const closest = buttons.reduce((best, button) => {
          const rect = button.getBoundingClientRect();
          const distance = Math.abs(rect.top + rect.height / 2 - center);
          return !best || distance < best.distance ? { button, distance } : best;
        }, null);
        const value = closest?.button?.dataset.value;
        if (value) this.setShiftEditorTime(part, value);
      }, 80);
    },
    saveShiftEdit() {
      if (!this.shiftEditorShift || !this.selectedProfile) return;

      const value = this.shiftEditorPreview;
      if (!this.updateActiveShiftValue(this.shiftEditorShift, value)) {
        this.statusText = "Could not find this shift in the CSV";
        return;
      }

      this.statusText = "Shift saved";
      this.closeShiftEditor();
    },
    clearShiftEditorValue() {
      this.shiftEditorMode = "off";
      this.shiftEditorIsAl = false;
      this.shiftEditorContext = "";
    },
    updateActiveShiftValue(targetShift, value) {
      const profile = this.selectedProfile;
      const rowIndex = profile?.originalRow;
      const columnIndex = targetShift?.columnIndex;
      if (!this.rosterDb || !Number.isInteger(rowIndex) || !Number.isInteger(columnIndex)) return false;

      let nextTable = this.table.map((row) => [...row]);
      while (nextTable.length <= rowIndex) nextTable.push([]);
      while (nextTable[rowIndex].length <= columnIndex) nextTable[rowIndex].push("");
      nextTable[rowIndex][columnIndex] = value;
      nextTable = padRows(nextTable);

      const hints = { ...this.cellReviewHints };
      delete hints[cellReviewKey(rowIndex, columnIndex)];
      const nextHints = pruneReviewHintsForTable(hints, nextTable);
      const nextProfiles = this.rosterDb.profiles.map((rosterProfile) => {
        if (rosterProfile.id !== profile.id) return rosterProfile;

        return {
          ...rosterProfile,
          shifts: rosterProfile.shifts.map((shift) =>
            isSameShiftSlot(shift, targetShift)
              ? {
                  ...shift,
                  value,
                }
              : shift,
          ),
        };
      });
      const nextRosterDb = {
        ...this.rosterDb,
        rawTable: nextTable,
        reviewHints: nextHints,
        profiles: nextProfiles,
      };

      this.table = nextTable;
      this.cellReviewHints = nextHints;
      this.rosterDb = nextRosterDb;
      writeCache(ROSTER_CACHE_KEY, nextRosterDb);
      return true;
    },
    saveDateEvent() {
      const key = shiftEventKey(this.eventEditorShift);
      if (!key) return;

      const text = normalizeEventText(this.eventEditorValue);
      const nextEvents = { ...this.dateEvents };
      if (text) {
        nextEvents[key] = text;
      } else {
        delete nextEvents[key];
      }

      this.dateEvents = nextEvents;
      writeCache(EVENT_CACHE_KEY, nextEvents);
      this.closeDateEventEditor();
    },
    removeDateEvent() {
      const key = shiftEventKey(this.eventEditorShift);
      if (!key) return;

      const nextEvents = { ...this.dateEvents };
      delete nextEvents[key];
      this.dateEvents = nextEvents;
      writeCache(EVENT_CACHE_KEY, nextEvents);
      this.closeDateEventEditor();
    },
    restoreNameAliases() {
      const aliases = readCache(NAME_CACHE_KEY);
      this.nameAliases = aliases && typeof aliases === "object" && !Array.isArray(aliases) ? aliases : {};
    },
    displayProfileName(profileOrName) {
      const defaultName = typeof profileOrName === "string" ? profileOrName : profileOrName?.name;
      if (!defaultName) return "";
      return this.nameAliases[nameAliasKey(defaultName)] || defaultName;
    },
    isEditedProfileName(profileOrName) {
      const defaultName = typeof profileOrName === "string" ? profileOrName : profileOrName?.name;
      return Boolean(defaultName && this.nameAliases[nameAliasKey(defaultName)]);
    },
    openNameEditor(profile) {
      if (!profile?.name) return;
      this.closeShiftEditor();
      this.nameEditorProfile = profile;
      this.nameEditorValue = this.displayProfileName(profile);
      nextTick(() => {
        this.refreshIcons();
        this.$refs.nameEditorInput?.focus?.();
        this.$refs.nameEditorInput?.select?.();
      });
    },
    closeNameEditor() {
      this.nameEditorProfile = null;
      this.nameEditorValue = "";
    },
    saveEditedName() {
      if (!this.nameEditorProfile?.name) return;

      const defaultName = cleanProfileName(this.nameEditorProfile.name);
      const editedName = cleanProfileName(this.nameEditorValue);
      if (!editedName || editedName === defaultName) {
        this.revertEditedName();
        return;
      }

      const nextAliases = {
        ...this.nameAliases,
        [nameAliasKey(defaultName)]: editedName,
      };
      this.nameAliases = nextAliases;
      writeCache(NAME_CACHE_KEY, nextAliases);
      this.closeNameEditor();
    },
    revertEditedName() {
      if (!this.nameEditorProfile?.name) return;

      const nextAliases = { ...this.nameAliases };
      delete nextAliases[nameAliasKey(this.nameEditorProfile.name)];
      this.nameAliases = nextAliases;
      writeCache(NAME_CACHE_KEY, nextAliases);
      this.closeNameEditor();
    },
    profileExists(profileId) {
      return Boolean(profileId && this.profiles.some((profile) => profile.id === profileId));
    },
    profileShiftCount(profile) {
      return (profile?.shifts || []).filter((shift) => isWorkShift(shift.value)).length;
    },
    profileOffCount(profile) {
      return (profile?.shifts || []).filter((shift) => isNonWorkingShift(shift.value)).length;
    },
    profileMorningShiftCount(profile) {
      return profileShiftTypeCount(profile, "morning");
    },
    profileEveningShiftCount(profile) {
      return profileShiftTypeCount(profile, "evening");
    },
    profileLateShiftCount(profile) {
      return profileShiftTypeCount(profile, "late");
    },
    profileInitials(name) {
      const base = cleanProfileName(name).replace(/\([^)]*\)/g, "").trim();
      const initials = base
        .split(/\s+/)
        .filter(Boolean)
        .map((part) => part[0])
        .join("")
        .slice(0, 2)
        .toUpperCase();
      return initials || [...base].slice(0, 2).join("") || "?";
    },
    displayShift(value) {
      return formatShiftForDisplay(value);
    },
    displayShiftMain(value) {
      return parseShiftDisplay(value).main;
    },
    displayShiftContext(value) {
      return parseShiftDisplay(value).context;
    },
    otherWorkingProfiles(shift) {
      if (!shift || !this.profiles.length) return [];

      return this.profiles
        .filter((profile) => profile.id !== this.selectedProfileId)
        .map((profile) => {
          const matchingShift = findMatchingShift(profile.shifts, shift);
          if (!matchingShift || !isWorkShift(matchingShift.value)) return null;

          const name = this.displayProfileName(profile);
          return {
            id: profile.id,
            profile,
            name,
            initials: this.profileInitials(name),
            time: this.displayShift(matchingShift.value),
            rawValue: String(matchingShift.value || "").trim(),
          };
        })
        .filter(Boolean)
        .sort((a, b) => shiftSortValue(a.rawValue) - shiftSortValue(b.rawValue) || a.name.localeCompare(b.name));
    },
    otherWorkingCount(shift) {
      return this.otherWorkingProfiles(shift).length;
    },
    handleCoworkerButtonClick(shift) {
      if (this.daySuppressClick || this.dayIsDragging || this.dayTransitionDirection || this.dayIsFastTraveling) return;
      this.openCoworkerModal(shift);
    },
    openCoworkerModal(shift) {
      if (!shift || !this.otherWorkingCount(shift)) return;
      this.coworkerModalShift = shift;
      nextTick(() => this.refreshIcons());
    },
    closeCoworkerModal() {
      this.coworkerModalShift = null;
    },
    shiftRelativeLabel(shift) {
      if (!shift?.dateKey) return "Shift";
      if (shift.dateKey === this.todayDateKey) return "Today";
      if (shift.dateKey === offsetDateKey(1)) return "Tomorrow";
      if (shift.dateKey === offsetDateKey(-1)) return "Yesterday";
      return shift.weekday || "Shift";
    },
    japaneseWeekdayLabel(weekday) {
      return japaneseWeekdayLabel(weekday);
    },
    isLeaveShift(value) {
      return isNonWorkingShift(value);
    },
    shiftPandaSrc(value) {
      return getShiftPandaSrc(value);
    },
    shiftClass(shift) {
      const type = getShiftType(shift.value);
      return {
        "is-work": isWorkShift(shift.value),
        "is-off": isNonWorkingShift(shift.value),
        "is-morning": type === "morning",
        "is-evening": type === "evening",
        "is-late": type === "late",
        "has-shift-art": Boolean(getShiftPandaSrc(shift.value)),
        "is-today": shift.dateKey === this.todayDateKey,
      };
    },
    syncSelectedShiftIndex() {
      const shifts = this.selectedProfile?.shifts || [];
      if (!shifts.length) {
        this.resetDayMotion();
        this.selectedShiftIndex = 0;
        return;
      }

      this.resetDayMotion();
      const todayIndex = shifts.findIndex((shift) => shift.dateKey === this.todayDateKey);
      this.selectedShiftIndex =
        todayIndex >= 0 ? todayIndex : Math.min(this.selectedShiftIndex, shifts.length - 1);
    },
    selectDay(index) {
      const shifts = this.selectedProfile?.shifts || [];
      if (!shifts.length) return;

      const targetIndex = Math.max(0, Math.min(index, shifts.length - 1));
      if (targetIndex === this.selectedShiftIndex && !this.dayTransitionDirection) {
        this.cancelDayFastTravel();
        return;
      }

      const distance = Math.abs(targetIndex - this.selectedShiftIndex);
      const direction = targetIndex > this.selectedShiftIndex ? "next" : "previous";

      if (this.dayTransitionDirection) {
        this.dayFastTravelTargetIndex = targetIndex;
        this.configureDayFastTravel(Math.abs(targetIndex - this.selectedShiftIndex));
        this.dayIsFastTraveling = true;
        return;
      }

      if (distance === 1) {
        this.cancelDayFastTravel();
        this.animateDay(direction);
        return;
      }

      this.dayFastTravelTargetIndex = targetIndex;
      this.configureDayFastTravel(distance);
      this.dayIsFastTraveling = true;
      this.stepDayFastTravel();
    },
    previousDay() {
      this.cancelDayFastTravel();
      this.animateDay("previous");
    },
    nextDay() {
      this.cancelDayFastTravel();
      this.animateDay("next");
    },
    animateDay(direction, options = {}) {
      const shifts = this.selectedProfile?.shifts || [];
      if (shifts.length <= 1 || this.dayTransitionDirection) return;

      const isFast = Boolean(options.fast);
      this.dayIsDragging = false;
      this.dayDragOffset = 0;
      this.dayTransitionDirection = direction;
      window.clearTimeout(this.dayTransitionTimer);
      this.dayTransitionTimer = window.setTimeout(() => {
        if (isFast && this.dayFastTravelTargetIndex !== null) {
          const targetIndex = Math.max(0, Math.min(this.dayFastTravelTargetIndex, shifts.length - 1));
          const distance = targetIndex - this.selectedShiftIndex;
          const stepSize = Math.max(1, Number(options.stepSize) || this.dayFastTravelStepSize || 1);
          const step = Math.min(Math.abs(distance), stepSize);
          this.selectedShiftIndex += Math.sign(distance) * step;
        } else {
          const delta = direction === "next" ? 1 : -1;
          this.selectedShiftIndex = clampIndex(this.selectedShiftIndex + delta, shifts.length);
        }

        this.dayTransitionDirection = "";
        this.dayTransitionTimer = null;
        if (isFast) {
          if (this.selectedShiftIndex === this.dayFastTravelTargetIndex) {
            this.cancelDayFastTravel();
            return;
          }

          window.clearTimeout(this.dayFastTravelTimer);
          this.dayFastTravelTimer = window.setTimeout(() => {
            this.stepDayFastTravel();
          }, DAY_FAST_FRAME_GAP_MS);
        }
      }, isFast ? DAY_FAST_TRANSITION_MS : DAY_TRANSITION_MS);
    },
    stepDayFastTravel() {
      const shifts = this.selectedProfile?.shifts || [];
      if (!shifts.length || this.dayFastTravelTargetIndex === null) {
        this.cancelDayFastTravel();
        return;
      }

      const targetIndex = Math.max(0, Math.min(this.dayFastTravelTargetIndex, shifts.length - 1));
      if (this.selectedShiftIndex === targetIndex) {
        this.cancelDayFastTravel();
        return;
      }

      if (this.dayTransitionDirection) return;

      const direction = targetIndex > this.selectedShiftIndex ? "next" : "previous";
      this.animateDay(direction, { fast: true, stepSize: this.dayFastTravelStepSize });
    },
    configureDayFastTravel(distance) {
      const visibleHopCount = Math.max(1, Math.min(DAY_FAST_MAX_HOPS, distance));
      this.dayFastTravelStepSize = Math.max(1, Math.ceil(distance / visibleHopCount));
    },
    cancelDayFastTravel() {
      window.clearTimeout(this.dayFastTravelTimer);
      this.dayFastTravelTimer = null;
      this.dayFastTravelTargetIndex = null;
      this.dayFastTravelStepSize = 1;
      this.dayIsFastTraveling = false;
    },
    resetDayMotion() {
      window.clearTimeout(this.dayTransitionTimer);
      window.clearTimeout(this.dayFastTravelTimer);
      window.clearTimeout(this.daySuppressClickTimer);
      this.daySwipeX = null;
      this.daySwipeY = null;
      this.dayDragOffset = 0;
      this.dayIsDragging = false;
      this.dayIsFastTraveling = false;
      this.dayFastTravelTargetIndex = null;
      this.dayFastTravelStepSize = 1;
      this.dayFastTravelTimer = null;
      this.dayTransitionDirection = "";
      this.dayTransitionTimer = null;
      this.daySuppressClick = false;
      this.daySuppressClickTimer = null;
    },
    suppressNextDayClick() {
      window.clearTimeout(this.daySuppressClickTimer);
      this.daySuppressClick = true;
      this.daySuppressClickTimer = window.setTimeout(() => {
        this.daySuppressClick = false;
        this.daySuppressClickTimer = null;
      }, 180);
    },
    handleDayArrowClick(direction) {
      if (this.daySuppressClick || this.dayIsDragging || this.dayTransitionDirection || this.dayIsFastTraveling) return;
      if (direction === "previous") this.previousDay();
      if (direction === "next") this.nextDay();
    },
    handleDayCardClick(slot) {
      if (this.daySuppressClick || this.dayIsDragging || this.dayTransitionDirection || this.dayIsFastTraveling) return;
      if (slot === "previous") this.previousDay();
      if (slot === "next") this.nextDay();
    },
    startDaySwipe(event) {
      if (this.dayTransitionDirection || this.dayIsFastTraveling) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      this.daySwipeX = Number(event.clientX);
      this.daySwipeY = Number(event.clientY);
      this.dayDragOffset = 0;
      this.dayIsDragging = true;
      event.currentTarget?.setPointerCapture?.(event.pointerId);
    },
    moveDaySwipe(event) {
      if (this.daySwipeX === null || this.dayTransitionDirection) return;

      const distance = Number(event.clientX) - this.daySwipeX;
      const verticalDistance = Math.abs(Number(event.clientY) - this.daySwipeY);
      if (Math.abs(distance) < verticalDistance) return;

      if (Math.abs(distance) > 8) event.preventDefault?.();
      this.dayDragOffset = distance * 0.62;
    },
    finishDaySwipe(event) {
      if (this.daySwipeX === null) return;
      const distance = Number(event.clientX) - this.daySwipeX;
      const verticalDistance = Math.abs(Number(event.clientY) - this.daySwipeY);
      const isHorizontalGesture = Math.abs(distance) >= 10 && Math.abs(distance) >= verticalDistance;
      this.daySwipeX = null;
      this.daySwipeY = null;
      this.dayIsDragging = false;
      this.dayDragOffset = 0;
      event.currentTarget?.releasePointerCapture?.(event.pointerId);

      if (isHorizontalGesture) this.suppressNextDayClick();
      if (Math.abs(distance) < 42 || Math.abs(distance) < verticalDistance) return;
      if (distance > 0) {
        this.previousDay();
      } else {
        this.nextDay();
      }
    },
    cancelDaySwipe() {
      this.daySwipeX = null;
      this.daySwipeY = null;
      this.dayDragOffset = 0;
      this.dayIsDragging = false;
    },
    openDataEditor() {
      if (!this.hasTable) return;
      this.closeCoworkerModal();
      this.showSpreadsheet = true;
      nextTick(() => this.refreshIcons());
    },
    closeDataEditor() {
      this.showSpreadsheet = false;
      nextTick(() => this.refreshIcons());
    },
    async shareActiveShift() {
      if (!this.activeShift || this.isSharing || this.dayTransitionDirection || this.dayIsFastTraveling) return;

      this.isSharing = true;
      this.statusText = "Preparing shift card...";

      try {
        const card = document.querySelector(".day-carousel-card.is-active");
        if (!card) throw new Error("No shift card is available to share.");
        if (!window.html2canvas) throw new Error("Share image tool is still loading. Try again in a moment.");

        await waitForFonts();
        await waitForImages(card);

        const canvas = await window.html2canvas(card, {
          backgroundColor: null,
          imageTimeout: 3000,
          logging: false,
          removeContainer: true,
          scale: Math.min(3, Math.max(2, window.devicePixelRatio || 2)),
          useCORS: true,
        });
        const blob = await canvasToPngBlob(canvas);
        const fileName = `${baseFileName(this.shareShiftFileName(this.activeShift))}.png`;
        const file = new File([blob], fileName, { type: "image/png" });

        if (isLikelyPhone() && canShareFile(file)) {
          await navigator.share({
            files: [file],
            title: "Shift card",
            text: this.shareShiftText(this.activeShift),
          });
          this.statusText = "Share sheet opened";
          return;
        }

        if (await copyPngToClipboard(blob)) {
          this.statusText = "Shift card copied to clipboard";
          return;
        }

        if (canShareFile(file)) {
          await navigator.share({
            files: [file],
            title: "Shift card",
            text: this.shareShiftText(this.activeShift),
          });
          this.statusText = "Share sheet opened";
          return;
        }

        downloadBlob(blob, fileName);
        this.statusText = "Shift card downloaded";
      } catch (error) {
        this.statusText =
          error?.name === "AbortError" ? "Share cancelled" : error.message || "Could not share this shift card";
      } finally {
        this.isSharing = false;
      }
    },
    shareShiftText(shift) {
      return [
        this.displayProfileName(this.selectedProfile),
        shift?.dateLabel,
        this.displayShift(shift?.value),
      ]
        .filter(Boolean)
        .join(" - ");
    },
    shareShiftFileName(shift) {
      return ["shift", this.displayProfileName(this.selectedProfile), shift?.dateKey || shift?.dateLabel]
        .filter(Boolean)
        .join("-");
    },
    cellReviewHint(rowIndex, cellIndex) {
      return this.cellReviewHints[cellReviewKey(rowIndex, cellIndex)] || "";
    },
    clearCellReviewHint(rowIndex, cellIndex) {
      const key = cellReviewKey(rowIndex, cellIndex);
      if (!this.cellReviewHints[key]) return;

      const nextHints = { ...this.cellReviewHints };
      delete nextHints[key];
      this.cellReviewHints = nextHints;
    },
    downloadCsv() {
      if (!this.hasTable) return;
      const blob = new Blob([this.toCsv()], { type: "text/csv;charset=utf-8" });
      const link = document.createElement("a");
      const sourceName = this.selectedFile?.name || this.rosterDb?.sourceFileName || "schedule";
      link.href = URL.createObjectURL(blob);
      link.download = `${baseFileName(sourceName)}-converted.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 500);
      this.statusText = "CSV downloaded";
    },
    async copyCsv() {
      if (!this.hasTable) return;
      try {
        await navigator.clipboard.writeText(this.toCsv());
        this.statusText = "CSV copied";
      } catch {
        this.statusText = "Clipboard permission blocked";
      }
    },
    toCsv() {
      return this.normalizedTable.map((row) => row.map(csvCell).join(",")).join("\n");
    },
    columnLabel(index) {
      let label = "";
      let value = index + 1;
      while (value > 0) {
        const remainder = (value - 1) % 26;
        label = String.fromCharCode(65 + remainder) + label;
        value = Math.floor((value - 1) / 26);
      }
      return label;
    },
    revokePreview() {
      if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
    },
    refreshIcons() {
      nextTick(() => {
        if (window.lucide) window.lucide.createIcons();
      });
    },
  },
}).mount("#app");

function readCurrentAppVersion() {
  const currentScript =
    document.currentScript ||
    [...document.scripts].find((script) => /(?:^|\/)app\.js(?:\?|$)/.test(script.src || ""));
  const candidates = [];

  try {
    if (currentScript?.src) {
      candidates.push(new URL(currentScript.src, window.location.href).searchParams.get("v"));
    }
  } catch {
    // Use the meta fallback below when the script URL is not parseable.
  }

  candidates.push(document.querySelector('meta[name="app-version"]')?.content);

  for (const candidate of candidates) {
    const version = Number(candidate);
    if (Number.isFinite(version) && version > 0) return version;
  }

  return 0;
}

function createRosterDatabase(table, sourceFileName = "", reviewHints = {}) {
  const rawTable = padRows(trimEmptyEdges(table)).map((row) => row.map((cell) => String(cell || "").trim()));
  const dateColumns = inferDateColumns(rawTable);
  const usedIds = new Set();
  const profiles = [];

  rawTable.forEach((row, rowIndex) => {
    const name = cleanProfileName(row[0]);
    if (!isProfileName(name)) return;

    const shifts = dateColumns.map((dateColumn) => ({
      columnIndex: dateColumn.columnIndex,
      day: dateColumn.day,
      weekday: dateColumn.weekday,
      dateLabel: dateColumn.dateLabel,
      dateKey: dateColumn.dateKey,
      value: normalizeCell(row[dateColumn.columnIndex] || ""),
    }));

    if (!shifts.some((shift) => shift.value)) return;

    const id = makeUniqueProfileId(name, rowIndex, usedIds);
    profiles.push({
      id,
      name,
      originalRow: rowIndex,
      shifts,
    });
  });

  const firstDate = dateColumns[0] || {};
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    sourceFileName,
    month: firstDate.monthNumber || new Date().getMonth() + 1,
    monthLabel: firstDate.monthLabel || monthShortName(new Date().getMonth() + 1),
    year: firstDate.year || new Date().getFullYear(),
    dateColumns,
    profiles,
    rawTable,
    reviewHints: normalizeReviewHints(reviewHints),
  };
}

function prepareOcrTableForSchedule(table, options = {}) {
  const cleanedTable = padRows(table).map((row) => row.map((cell) => String(cell || "").trim()));
  const reviewHints = {};
  const dateColumns = inferDateColumns(cleanedTable);
  if (!dateColumns.length) return { table: cleanedTable, reviewHints };

  cleanedTable.forEach((row, rowIndex) => {
    const name = cleanProfileName(row[0]);
    if (!isProfileName(name)) return;

    const shiftValues = dateColumns.map((dateColumn) => String(row[dateColumn.columnIndex] || "").trim());
    const filledShiftCount = shiftValues.filter(Boolean).length;
    const rowFillRatio = filledShiftCount / Math.max(1, dateColumns.length);

    dateColumns.forEach((dateColumn, dateIndex) => {
      const columnIndex = dateColumn.columnIndex;
      const originalText = String(row[columnIndex] || "").trim();
      const normalized = normalizeOcrShiftCell(originalText);

      if (originalText) {
        if (normalized.value) {
          row[columnIndex] = normalized.value;
          return;
        }

        row[columnIndex] = "";
        reviewHints[cellReviewKey(rowIndex, columnIndex)] = `Ignored OCR text: ${originalText}`;
        return;
      }

      const hasNearbyShifts = Boolean(shiftValues[dateIndex - 1] || shiftValues[dateIndex + 1]);
      const shouldCheckBlank =
        (rowFillRatio >= 0.65 || hasNearbyShifts) &&
        cellLooksLikeMissedText(options.imageCanvas, options.grid, options.rowMap?.[rowIndex] ?? rowIndex, columnIndex);

      if (shouldCheckBlank) {
        reviewHints[cellReviewKey(rowIndex, columnIndex)] = "Possible missed shift text";
      }
    });
  });

  return {
    table: cleanedTable,
    reviewHints,
  };
}

function inferDateColumns(table) {
  const width = table.reduce((max, row) => Math.max(max, row.length), 0);
  const dateRowIndex = findDateRowIndex(table);
  const dayRowIndex = findLabelRowIndex(table, "day");
  const dateRow = table[dateRowIndex] || [];
  const dayRow = table[dayRowIndex] || [];
  let explicitColumns = collectDateColumnsFromRow(dateRow, dayRow, width);

  if (!explicitColumns.length) {
    const bestRow = findRowWithMostDates(table);
    explicitColumns = collectDateColumnsFromRow(table[bestRow] || [], dayRow, width);
  }

  const firstExplicit = explicitColumns[0];
  const monthNumber =
    explicitColumns.find((column) => column.monthNumber)?.monthNumber || new Date().getMonth() + 1;
  const monthLabel = monthShortName(monthNumber);
  const year = inferRosterYear(monthNumber);
  const daysThisMonth = daysInMonth(year, monthNumber);
  const firstColumn = firstExplicit?.columnIndex || 1;
  const firstDay = firstExplicit?.day || 1;
  const lastExplicitColumn = explicitColumns[explicitColumns.length - 1]?.columnIndex || firstColumn;
  const lastColumn = Math.min(width - 1, Math.max(lastExplicitColumn, firstColumn + daysThisMonth - firstDay));
  const byColumn = new Map(explicitColumns.map((column) => [column.columnIndex, column]));
  const columns = [];

  for (let columnIndex = firstColumn; columnIndex <= lastColumn; columnIndex += 1) {
    const explicit = byColumn.get(columnIndex);
    const day = explicit?.day || firstDay + columnIndex - firstColumn;
    if (day < 1 || day > daysThisMonth) continue;

    const date = new Date(year, monthNumber - 1, day);
    const weekday = normalizeWeekday(dayRow[columnIndex]) || shortWeekday(date);
    columns.push({
      columnIndex,
      day,
      weekday,
      monthNumber,
      monthLabel,
      year,
      dateLabel: `${day}-${monthLabel}`,
      dateKey: formatDateKey(date),
    });
  }

  return columns;
}

function collectDateColumnsFromRow(dateRow, dayRow, width) {
  const columns = [];

  for (let columnIndex = 1; columnIndex < width; columnIndex += 1) {
    const parsed = parseDateCell(dateRow[columnIndex]);
    if (!parsed) continue;

    columns.push({
      columnIndex,
      ...parsed,
      weekday: normalizeWeekday(dayRow[columnIndex]),
    });
  }

  return columns.sort((a, b) => a.columnIndex - b.columnIndex);
}

function findDateRowIndex(table) {
  const explicitIndex = findLabelRowIndex(table, "date");
  if (explicitIndex >= 0) return explicitIndex;
  return findRowWithMostDates(table);
}

function findLabelRowIndex(table, label) {
  const normalizedLabel = label.toLowerCase();
  return table.findIndex((row) => normalizeHeader(row[0]) === normalizedLabel);
}

function findRowWithMostDates(table) {
  let bestRow = -1;
  let bestCount = 0;
  const scanLimit = Math.min(table.length, 8);

  for (let rowIndex = 0; rowIndex < scanLimit; rowIndex += 1) {
    const count = table[rowIndex].filter((cell, columnIndex) => columnIndex > 0 && parseDateCell(cell)).length;
    if (count > bestCount) {
      bestRow = rowIndex;
      bestCount = count;
    }
  }

  return bestCount >= 2 ? bestRow : -1;
}

function parseDateCell(value) {
  const text = String(value || "")
    .replace(/[|()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;

  const match = text.match(/\b(\d{1,2})\s*[-/. ]\s*([A-Za-z]{3,9}|\d{1,2})\b/);
  if (!match) return null;

  const day = Number(match[1]);
  const monthNumber = parseMonthToken(match[2]);
  if (!Number.isInteger(day) || day < 1 || day > 31 || !monthNumber) return null;

  return {
    day,
    monthNumber,
    monthLabel: monthShortName(monthNumber),
  };
}

function parseMonthToken(value) {
  const token = String(value || "").toLowerCase();
  const numeric = Number(token);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= 12) return numeric;

  const monthAliases = new Map([
    ["jan", 1],
    ["feb", 2],
    ["mar", 3],
    ["apr", 4],
    ["may", 5],
    ["jun", 6],
    ["jul", 7],
    ["aug", 8],
    ["sep", 9],
    ["sept", 9],
    ["oct", 10],
    ["nov", 11],
    ["dec", 12],
  ]);

  return monthAliases.get(token.slice(0, 4)) || monthAliases.get(token.slice(0, 3)) || 0;
}

function normalizeWeekday(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "";

  const weekdays = new Map([
    ["sun", "Sun"],
    ["mon", "Mon"],
    ["tue", "Tue"],
    ["tues", "Tue"],
    ["wed", "Wed"],
    ["thu", "Thu"],
    ["thur", "Thu"],
    ["thurs", "Thu"],
    ["fri", "Fri"],
    ["sat", "Sat"],
  ]);

  return weekdays.get(text.slice(0, 5)) || weekdays.get(text.slice(0, 4)) || weekdays.get(text.slice(0, 3)) || "";
}

function inferRosterYear(monthNumber) {
  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();
  if (monthNumber === 12 && currentMonth === 1) return currentYear - 1;
  if (monthNumber === 1 && currentMonth === 12) return currentYear + 1;
  return currentYear;
}

function daysInMonth(year, monthNumber) {
  return new Date(year, monthNumber, 0).getDate();
}

function shortWeekday(date) {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getDay()];
}

function japaneseWeekdayLabel(weekday) {
  const labels = new Map([
    ["sun", "日"],
    ["mon", "月"],
    ["tue", "火"],
    ["wed", "水"],
    ["thu", "木"],
    ["fri", "金"],
    ["sat", "土"],
  ]);
  const key = String(weekday || "").trim().slice(0, 3).toLowerCase();
  return labels.get(key) || weekday || "";
}

function shiftEventKey(shift) {
  if (!shift) return "";
  return shift.dateKey || [shift.year, shift.monthNumber, shift.day].filter(Boolean).join("-") || shift.dateLabel || "";
}

function normalizeEventText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function formatDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function offsetDateKey(offsetDays) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return formatDateKey(date);
}

function clampIndex(index, length) {
  if (!length) return 0;
  return ((index % length) + length) % length;
}

function isProfileName(value) {
  const name = cleanProfileName(value);
  const normalized = normalizeProfileLabel(name);
  return Boolean(name) && !["guest services", "day", "date"].includes(normalized);
}

function cleanProfileName(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function nameAliasKey(value) {
  return cleanProfileName(value).toLowerCase();
}

function normalizeProfileLabel(value) {
  return cleanProfileName(value)
    .replace(/[：:]+$/g, "")
    .toLowerCase();
}

function makeUniqueProfileId(name, rowIndex, usedIds) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = slug || `profile-${rowIndex + 1}`;
  let candidate = base;
  let counter = 2;

  while (usedIds.has(candidate)) {
    candidate = `${base}-${counter}`;
    counter += 1;
  }

  usedIds.add(candidate);
  return candidate;
}

function isWorkShift(value) {
  const shift = String(value || "").trim().toUpperCase();
  return Boolean(shift) && !isNonWorkingShift(shift);
}

function isNonWorkingShift(value) {
  const shift = String(value || "").trim().toUpperCase();
  return ["OFF", "ROFF", "AL", "SAL", "/"].includes(shift);
}

function profileShiftTypeCount(profile, type) {
  return (profile?.shifts || []).filter((shift) => getShiftType(shift.value) === type).length;
}

function getShiftPandaSrc(value) {
  const type = getShiftType(value);
  if (type === "off") return SHIFT_PANDA_IMAGES.off;
  if (type === "late") return SHIFT_PANDA_IMAGES.late;
  if (type === "morning" || type === "evening" || type === "work") {
    return SHIFT_PANDA_IMAGES.work;
  }
  return "";
}

function getShiftType(value) {
  if (isNonWorkingShift(value)) return "off";
  if (!isWorkShift(value)) return "";

  const startHour = shiftStartHour(value);
  if (!Number.isFinite(startHour)) return "work";
  if (startHour < 12) return "morning";
  if (startHour > 18) return "late";
  return "evening";
}

function shiftStartHour(value) {
  const match = String(value || "").trim().match(/\d{1,2}(?::\d{1,2}|\.\d+)?/);
  if (!match) return Number.NaN;

  const token = match[0];
  if (token.includes(":")) {
    const [hourPart, minutePart] = token.split(":");
    const hours = Number(hourPart);
    const minutes = Number(minutePart);
    if (
      !Number.isFinite(hours) ||
      !Number.isFinite(minutes) ||
      hours < 0 ||
      hours > 24 ||
      minutes < 0 ||
      minutes >= 60
    ) {
      return Number.NaN;
    }

    return hours + minutes / 60;
  }

  const numeric = Number(token);
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= 24 ? numeric : Number.NaN;
}

function findMatchingShift(shifts, targetShift) {
  if (!Array.isArray(shifts) || !targetShift) return null;

  return (
    shifts.find((shift) => targetShift.dateKey && shift.dateKey === targetShift.dateKey) ||
    shifts.find((shift) => Number.isInteger(targetShift.columnIndex) && shift.columnIndex === targetShift.columnIndex) ||
    shifts.find((shift) => shift.day === targetShift.day && shift.dateLabel === targetShift.dateLabel) ||
    null
  );
}

function isSameShiftSlot(shift, targetShift) {
  if (!shift || !targetShift) return false;
  if (shift === targetShift) return true;
  if (shift.dateKey && targetShift.dateKey) return shift.dateKey === targetShift.dateKey;
  if (Number.isInteger(shift.columnIndex) && Number.isInteger(targetShift.columnIndex)) {
    return shift.columnIndex === targetShift.columnIndex;
  }
  return shift.day === targetShift.day && shift.dateLabel === targetShift.dateLabel;
}

function shiftSortValue(value) {
  const startHour = shiftStartHour(value);
  return Number.isFinite(startHour) ? startHour : Number.POSITIVE_INFINITY;
}

function formatShiftForDisplay(value) {
  const display = parseShiftDisplay(value);
  return display.context ? `${display.main} ${display.context}` : display.main;
}

function parseShiftDisplay(value) {
  const shift = String(value || "").trim();
  if (!shift) return { main: "-", context: "" };
  if (isNonWorkingShift(shift)) return { main: shift.toUpperCase(), context: "" };

  const rangeMatch = shift.match(/^(\d{1,2}(?::\d{1,2}|\.\d+)?)\s*-\s*(\d{1,2}(?::\d{1,2}|\.\d+)?)(.*)$/);
  if (rangeMatch) {
    const start = formatClockToken(rangeMatch[1]);
    const end = formatClockToken(rangeMatch[2]);
    return {
      main: `${start} - ${end}`,
      context: normalizeShiftContext(rangeMatch[3]),
    };
  }

  const timeMatch = shift.match(/^(\d{1,2}(?::\d{1,2}|\.\d+)?)(.*)$/);
  if (!timeMatch) return { main: shift, context: "" };

  const clock = formatClockToken(timeMatch[1]);
  return {
    main: clock,
    context: normalizeShiftContext(timeMatch[2]),
  };
}

function normalizeShiftContext(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "( ")
    .replace(/\s+\)/g, " )")
    .trim();
}

function formatClockToken(value) {
  const token = String(value || "").trim();
  if (token.includes(":")) {
    const [hourPart, minutePart] = token.split(":");
    const hours = Number(hourPart);
    const minutes = Number(minutePart);
    if (
      !Number.isFinite(hours) ||
      !Number.isFinite(minutes) ||
      hours < 0 ||
      hours > 24 ||
      minutes < 0 ||
      minutes >= 60
    ) {
      return token;
    }

    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return token;

  let hours = Math.floor(numeric);
  let minutes = Math.round((numeric - hours) * 60);
  if (minutes >= 60) {
    hours += Math.floor(minutes / 60);
    minutes %= 60;
  }

  if (hours < 0 || hours > 24) return String(value);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function isValidRosterDatabase(value) {
  return (
    value?.version === 1 &&
    Array.isArray(value.dateColumns) &&
    Array.isArray(value.profiles) &&
    value.profiles.every((profile) => profile?.id && Array.isArray(profile.shifts))
  );
}

function writeCache(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.warn("Could not write local cache", error);
  }
}

function readCache(key) {
  try {
    const value = window.localStorage.getItem(key);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function writeTextCache(key, value) {
  try {
    window.localStorage.setItem(key, String(value));
  } catch (error) {
    console.warn("Could not write local cache", error);
  }
}

function readTextCache(key) {
  try {
    return window.localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function removeCache(key) {
  try {
    window.localStorage.removeItem(key);
  } catch (error) {
    console.warn("Could not clear local cache", error);
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("This image could not be opened."));
    image.src = src;
  });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || "");
      resolve(value.includes(",") ? value.split(",").pop() : value);
    };
    reader.onerror = () => reject(new Error("Could not read this image file."));
    reader.readAsDataURL(file);
  });
}

function isImageFile(file) {
  if (!file) return false;
  return file.type.startsWith("image/") || /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name);
}

function makeImageCanvas(image) {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0);
  return canvas;
}

function preprocessImageForOcr(sourceCanvas) {
  const scale = chooseOcrScale(sourceCanvas.width, sourceCanvas.height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sourceCanvas.width * scale));
  canvas.height = Math.max(1, Math.round(sourceCanvas.height * scale));

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(sourceCanvas, 0, 0, canvas.width, canvas.height);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;

  for (let offset = 0; offset < data.length; offset += 4) {
    const red = data[offset];
    const green = data[offset + 1];
    const blue = data[offset + 2];
    const lightness = red * 0.299 + green * 0.587 + blue * 0.114;
    const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
    let gray = lightness;

    if (chroma > 28 && lightness > 118) {
      gray = Math.min(255, gray + 54);
    }

    gray = (gray - 128) * 1.55 + 128;
    if (gray > 218) gray = 255;
    if (gray < 158) gray = Math.max(0, gray - 36);

    const value = clampColor(gray);
    data[offset] = value;
    data[offset + 1] = value;
    data[offset + 2] = value;
    data[offset + 3] = 255;
  }

  ctx.putImageData(imageData, 0, 0);

  const pngBase64 = canvasToBase64(canvas, "image/png");
  if (pngBase64.length <= 11_500_000) {
    return { base64: pngBase64, mimeType: "image/png", scale };
  }

  return {
    base64: canvasToBase64(canvas, "image/jpeg", 0.9),
    mimeType: "image/jpeg",
    scale,
  };
}

function chooseOcrScale(width, height) {
  const longEdge = Math.max(width, height);
  if (longEdge <= 0) return 1;
  const fitScale = Math.min(2.6, 3200 / longEdge);
  if (longEdge < 1800) return Math.max(1.5, fitScale);
  if (longEdge < 3200) return Math.max(1, fitScale);
  return fitScale;
}

function canvasToBase64(canvas, mimeType, quality) {
  const value = canvas.toDataURL(mimeType, quality);
  return value.includes(",") ? value.split(",").pop() : value;
}

function scaleGrid(grid, scale) {
  if (!grid?.isUsable || scale === 1) return grid;
  return {
    ...grid,
    verticals: grid.verticals.map((line) => line * scale),
    horizontals: grid.horizontals.map((line) => line * scale),
  };
}

function clampColor(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function detectTableGrid(canvas) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  const dark = new Uint8Array(width * height);
  const rowCounts = new Uint32Array(height);
  const columnCounts = new Uint32Array(width);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const gray = data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114;
      if (gray < 132) {
        dark[y * width + x] = 1;
        rowCounts[y] += 1;
        columnCounts[x] += 1;
      }
    }
  }

  const initialHorizontalDensity = toDensity(rowCounts, width);
  let horizontals = findLines(initialHorizontalDensity, [0.55, 0.42, 0.3, 0.2, 0.12], 4, 14, 5);
  const tableY = boundsFromLines(horizontals, height);

  const verticalCounts = new Uint32Array(width);
  for (let y = tableY.start; y <= tableY.end; y += 1) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x += 1) {
      verticalCounts[x] += dark[rowOffset + x];
    }
  }

  const verticalDensity = toDensity(verticalCounts, tableY.end - tableY.start + 1);
  const verticals = findLines(verticalDensity, [0.55, 0.42, 0.3, 0.2, 0.12, 0.07], 6, 14, 5);
  const tableX = boundsFromLines(verticals, width);

  const refinedRowCounts = new Uint32Array(height);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * width;
    for (let x = tableX.start; x <= tableX.end; x += 1) {
      refinedRowCounts[y] += dark[rowOffset + x];
    }
  }

  const refinedHorizontalDensity = toDensity(refinedRowCounts, tableX.end - tableX.start + 1);
  horizontals = findLines(refinedHorizontalDensity, [0.55, 0.42, 0.3, 0.2, 0.12, 0.07], 4, 14, 5);
  completeRegularLines(verticals, width);
  completeRegularLines(horizontals, height);

  return {
    verticals,
    horizontals,
    isUsable: verticals.length >= 3 && horizontals.length >= 3,
  };
}

function toDensity(counts, divisor) {
  return Array.from(counts, (count) => count / Math.max(1, divisor));
}

function boundsFromLines(lines, size) {
  if (lines.length >= 2) {
    return {
      start: Math.max(0, lines[0] - 2),
      end: Math.min(size - 1, lines[lines.length - 1] + 2),
    };
  }

  return { start: 0, end: size - 1 };
}

function findLines(density, thresholds, minCount, maxRun, mergeGap) {
  for (const threshold of thresholds) {
    const lines = mergeCloseLines(collectLineRuns(density, threshold, maxRun), mergeGap);
    if (lines.length >= minCount) return lines;
  }

  return mergeCloseLines(
    collectLineRuns(density, thresholds[thresholds.length - 1], maxRun),
    mergeGap,
  );
}

function collectLineRuns(density, threshold, maxRun) {
  const lines = [];
  let start = -1;

  for (let index = 0; index < density.length; index += 1) {
    const isLine = density[index] >= threshold;
    if (isLine && start === -1) {
      start = index;
    } else if ((!isLine || index === density.length - 1) && start !== -1) {
      const end = isLine && index === density.length - 1 ? index : index - 1;
      const length = end - start + 1;
      if (length <= maxRun) lines.push(Math.round((start + end) / 2));
      start = -1;
    }
  }

  return lines;
}

function mergeCloseLines(lines, gap) {
  if (!lines.length) return [];
  const sorted = [...lines].sort((a, b) => a - b);
  const merged = [sorted[0]];

  for (let index = 1; index < sorted.length; index += 1) {
    const current = sorted[index];
    const previous = merged[merged.length - 1];
    if (current - previous <= gap) {
      merged[merged.length - 1] = Math.round((current + previous) / 2);
    } else {
      merged.push(current);
    }
  }

  return merged;
}

function completeRegularLines(lines, size) {
  if (lines.length < 3) return;

  const gaps = [];
  for (let index = 1; index < lines.length - 1; index += 1) {
    gaps.push(lines[index + 1] - lines[index]);
  }

  const unit = median(gaps.filter((gap) => gap > 8));
  if (!unit) return;

  for (let index = 1; index < lines.length - 1; index += 1) {
    const gap = lines[index + 1] - lines[index];
    if (gap > unit * 1.55) {
      const insertCount = Math.round(gap / unit) - 1;
      for (let offset = 1; offset <= insertCount; offset += 1) {
        lines.splice(index + offset, 0, Math.round(lines[index] + unit * offset));
      }
      index += insertCount;
    }
  }

  if (lines[0] > 0 && lines[0] <= unit * 0.45) {
    lines[0] = 0;
  }

  const lastGap = size - 1 - lines[lines.length - 1];
  if (lastGap > unit * 0.45 && lastGap < unit * 1.55) {
    lines.push(size - 1);
  }
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function wordsToTable(words, grid) {
  const rowCount = Math.max(0, grid.horizontals.length - 1);
  const columnCount = Math.max(0, grid.verticals.length - 1);
  const cells = Array.from({ length: rowCount }, () =>
    Array.from({ length: columnCount }, () => []),
  );

  words.forEach((word) => {
    const text = cleanWord(word.text);
    if (!text || !hasGoodConfidence(word.confidence)) return;

    const centerX = (word.x0 + word.x1) / 2;
    const centerY = (word.y0 + word.y1) / 2;
    const columnIndex = findCellIndex(grid.verticals, centerX);
    const rowIndex = findCellIndex(grid.horizontals, centerY);

    if (rowIndex < 0 || columnIndex < 0) return;
    cells[rowIndex][columnIndex].push({
      text,
      x: word.x0,
      y: word.y0,
    });
  });

  return cells.map((row) =>
    row.map((cell) =>
      normalizeCell(
        cell
          .sort((a, b) => (Math.abs(a.y - b.y) < 8 ? a.x - b.x : a.y - b.y))
          .map((item) => item.text)
          .join(" "),
      ),
    ),
  );
}

function hasGoodConfidence(value) {
  if (value === "" || value === null || value === undefined) return true;
  const confidence = Number(value);
  if (!Number.isFinite(confidence)) return true;
  return confidence <= 1 ? confidence >= 0.08 : confidence >= 8;
}

function findCellIndex(lines, point) {
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (point >= lines[index] && point < lines[index + 1]) return index;
  }

  return -1;
}

function cellLooksLikeMissedText(canvas, grid, rowIndex, columnIndex) {
  if (!canvas || !grid?.isUsable) return false;

  const bounds = gridCellBounds(grid, rowIndex, columnIndex);
  if (!bounds) return false;

  const width = bounds.x1 - bounds.x0;
  const height = bounds.y1 - bounds.y0;
  if (width < 6 || height < 6) return false;

  const marginX = Math.max(2, Math.floor(width * 0.18));
  const marginY = Math.max(2, Math.floor(height * 0.2));
  const sampleX = bounds.x0 + marginX;
  const sampleY = bounds.y0 + marginY;
  const sampleWidth = Math.max(1, width - marginX * 2);
  const sampleHeight = Math.max(1, height - marginY * 2);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const imageData = ctx.getImageData(sampleX, sampleY, sampleWidth, sampleHeight).data;
  let inkPixels = 0;
  let strongInkPixels = 0;
  const totalPixels = sampleWidth * sampleHeight;

  for (let offset = 0; offset < imageData.length; offset += 4) {
    const red = imageData[offset];
    const green = imageData[offset + 1];
    const blue = imageData[offset + 2];
    const lightness = red * 0.299 + green * 0.587 + blue * 0.114;
    const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
    const isInk = lightness < 142 || (chroma > 42 && lightness < 178);

    if (isInk) inkPixels += 1;
    if (lightness < 108) strongInkPixels += 1;
  }

  const inkRatio = inkPixels / Math.max(1, totalPixels);
  const strongInkRatio = strongInkPixels / Math.max(1, totalPixels);
  return inkRatio >= 0.018 || strongInkRatio >= 0.008;
}

function gridCellBounds(grid, rowIndex, columnIndex) {
  const x0 = Math.ceil(grid.verticals[columnIndex]);
  const x1 = Math.floor(grid.verticals[columnIndex + 1]);
  const y0 = Math.ceil(grid.horizontals[rowIndex]);
  const y1 = Math.floor(grid.horizontals[rowIndex + 1]);

  if (![x0, x1, y0, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) return null;
  return { x0, x1, y0, y1 };
}

function textToTable(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const cells = line.includes("\t")
        ? line.split(/\t+/)
        : line.split(/\s{2,}| {1,}(?=\d{1,2}-[A-Za-z]{3})/);
      return cells.map(normalizeCell);
    });
}

function trimEmptyEdges(table) {
  return trimEmptyEdgesWithMap(table).table;
}

function trimEmptyEdgesWithMap(table) {
  const rows = table.filter((row) => row.some((cell) => String(cell).trim()));
  const rowMap = table
    .map((row, rowIndex) => ({ row, rowIndex }))
    .filter((entry) => entry.row.some((cell) => String(cell).trim()))
    .map((entry) => entry.rowIndex);
  if (!rows.length) return { table: [], rowMap: [] };

  const lastColumn = rows.reduce((max, row) => {
    for (let index = row.length - 1; index >= 0; index -= 1) {
      if (String(row[index] || "").trim()) return Math.max(max, index);
    }
    return max;
  }, 0);

  return {
    table: rows.map((row) => row.slice(0, lastColumn + 1)),
    rowMap,
  };
}

function padRows(table) {
  const width = table.reduce((max, row) => Math.max(max, row.length), 0);
  return table.map((row) => {
    const next = [...row];
    while (next.length < width) next.push("");
    return next;
  });
}

function countFilledCells(table) {
  return table.reduce(
    (count, row) => count + row.filter((cell) => String(cell || "").trim()).length,
    0,
  );
}

function cleanWord(value) {
  return String(value || "")
    .replace(/[|_[\]{}]/g, "")
    .trim();
}

function normalizeHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

function normalizeCell(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";

  const upper = text.toUpperCase();
  const corrected = upper
    .replace(/\b0FF\b/g, "OFF")
    .replace(/\bOFE\b/g, "OFF")
    .replace(/\bOF F\b/g, "OFF")
    .replace(/\bR0FF\b/g, "ROFF")
    .replace(/\bROF F\b/g, "ROFF")
    .replace(/\b5AL\b/g, "SAL")
    .replace(/\bSA1\b/g, "SAL")
    .replace(/\bA1\b/g, "AL")
    .replace(/\b225\b/g, "22.5")
    .replace(/\b22[ S]5\b/g, "22.5")
    .replace(/\b(\d{1,2})\s*\(?TR\)?\b/g, "$1 (TR)")
    .replace(/\b(\d{1,2})\s*\(?CDT\)?\b/g, "$1 (CDT)")
    .replace(/\b(\d{1,2})\s*CON\b/g, "$1 CON");

  const shiftValue = canonicalShiftValue(corrected);
  if (shiftValue) return shiftValue;

  if (/^\d{1,2}-[A-Z]{3}$/.test(corrected)) {
    return corrected.replace(/-([A-Z]{3})$/, (_, month) => {
      return `-${month[0]}${month.slice(1).toLowerCase()}`;
    });
  }

  return text;
}

function normalizeOcrShiftCell(value) {
  const text = String(value || "")
    .normalize("NFKC")
    .replace(/[|_[\]{}"'`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return { value: "" };

  const direct = canonicalShiftValue(text);
  if (direct) return { value: direct };

  const compact = text
    .toUpperCase()
    .replace(/\b0FF\b/g, "OFF")
    .replace(/\bOFE\b/g, "OFF")
    .replace(/\bOF F\b/g, "OFF")
    .replace(/\bR0FF\b/g, "ROFF")
    .replace(/\bROF F\b/g, "ROFF")
    .replace(/\b5AL\b/g, "SAL")
    .replace(/\bSA1\b/g, "SAL")
    .replace(/\bA1\b/g, "AL")
    .replace(/\bB\b/g, "8")
    .replace(/\bI\b/g, "1")
    .replace(/\bO\b/g, "0")
    .replace(/\s*\(\s*/g, " (")
    .replace(/\s*\)\s*/g, ")")
    .replace(/\s+/g, " ")
    .trim();

  const corrected = canonicalShiftValue(compact);
  if (corrected) return { value: corrected };

  const tokenMatch = compact.match(/\b(?:OFF|ROFF|SAL|AL|\/|\d{1,2}(?::[0-5]\d|\.[05])?(?:\s*(?:\([A-Z0-9 ]{1,10}\)|[A-Z]{1,10}))?)\b/);
  const token = tokenMatch ? canonicalShiftValue(tokenMatch[0]) : "";
  return { value: token };
}

function normalizeManualShiftValue(value) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";

  return canonicalShiftValue(text) || normalizeCell(text);
}

function shiftValueToEditorState(value) {
  const shift = String(value || "").trim();
  const upper = shift.toUpperCase();
  const display = parseShiftDisplay(shift);
  const startHour = shiftStartHour(shift);
  const hour = Number.isFinite(startHour) ? Math.floor(startHour) : 9;
  const minute = Number.isFinite(startHour) && startHour % 1 >= 0.5 ? "30" : "00";

  return {
    mode: isNonWorkingShift(shift) ? "off" : "work",
    isAl: upper === "AL" || upper === "SAL",
    hour: String(hour).padStart(2, "0"),
    minute,
    context: unwrapShiftContext(display.context),
  };
}

function buildShiftEditorValue(state) {
  if (state?.mode === "off") return state.isAl ? "AL" : "OFF";

  const hour = SHIFT_EDITOR_HOURS.includes(String(state?.hour)) ? String(state.hour) : "09";
  const minute = SHIFT_EDITOR_MINUTES.includes(String(state?.minute)) ? String(state.minute) : "00";
  const context = normalizeShiftEditorContext(state?.context);
  return `${hour}:${minute}${context ? ` ${context}` : ""}`;
}

function unwrapShiftContext(value) {
  return String(value || "")
    .replace(/^\(\s*/, "")
    .replace(/\s*\)$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SHIFT_CONTEXT_MAX_LENGTH);
}

function normalizeShiftEditorContext(value) {
  const text = String(value || "")
    .normalize("NFKC")
    .replace(/[|_[\]{}"'`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SHIFT_CONTEXT_MAX_LENGTH);

  if (!text) return "";
  const unwrapped = unwrapShiftContext(text);
  return unwrapped ? `(${unwrapped})` : "";
}

function canonicalShiftValue(value) {
  const text = String(value || "")
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[|_[\]{}"'`]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s*\(\s*/g, " (")
    .replace(/\s*\)\s*/g, ")")
    .replace(/\b225\b/g, "22.5")
    .replace(/\b22[ S]5\b/g, "22.5")
    .replace(/\b(\d{1,2})\s*\(?TR\)?\b/g, "$1 (TR)")
    .replace(/\b(\d{1,2})\s*\(?CDT\)?\b/g, "$1 (CDT)")
    .replace(/\b(\d{1,2})\s*CON\b/g, "$1 CON")
    .trim();

  if (/^(OFF|ROFF|SAL|AL|\/)$/.test(text)) return text;

  const rangeMatch = text.match(/^(\d{1,2}(?::[0-5]\d|\.[05])?)\s*-\s*(\d{1,2}(?::[0-5]\d|\.[05])?)(.*)$/);
  if (rangeMatch && validHour(rangeMatch[1]) && validHour(rangeMatch[2])) {
    const context = canonicalShiftContext(rangeMatch[3]);
    if (rangeMatch[3] && !context) return "";
    return `${rangeMatch[1]}-${rangeMatch[2]}${context ? ` ${context}` : ""}`;
  }

  const timeMatch = text.match(/^(\d{1,2}(?::[0-5]\d|\.[05])?)(.*)$/);
  if (!timeMatch || !validHour(timeMatch[1])) return "";

  const context = canonicalShiftContext(timeMatch[2]);
  if (timeMatch[2] && !context) return "";

  return `${timeMatch[1]}${context ? ` ${context}` : ""}`;
}

function canonicalShiftContext(value) {
  const raw = String(value || "").normalize("NFKC").trim();
  if (!raw) return "";

  let token = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/^T[R]?$/g, "TR")
    .replace(/^CD[T]?$/g, "CDT");

  if (!VALID_SHIFT_CONTEXTS.has(token)) return "";
  return token === "CON" ? "CON" : `(${token})`;
}

function validHour(value) {
  const hour = Number(String(value).match(/^\d{1,2}/)?.[0]);
  return Number.isInteger(hour) && hour >= 0 && hour <= 24;
}

function cellReviewKey(rowIndex, cellIndex) {
  return `${rowIndex}:${cellIndex}`;
}

function normalizeReviewHints(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, hint]) => /^\d+:\d+$/.test(key) && String(hint || "").trim())
      .map(([key, hint]) => [key, String(hint).replace(/\s+/g, " ").trim().slice(0, 120)]),
  );
}

function pruneReviewHintsForTable(reviewHints, table) {
  const hints = normalizeReviewHints(reviewHints);

  return Object.fromEntries(
    Object.entries(hints).filter(([key]) => {
      const [rowIndex, cellIndex] = key.split(":").map(Number);
      return Boolean(table[rowIndex]) && cellIndex >= 0 && cellIndex < table[rowIndex].length;
    }),
  );
}

function monthShortName(monthNumber) {
  return ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][
    monthNumber - 1
  ];
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function waitForFonts() {
  try {
    if (document.fonts?.ready) await document.fonts.ready;
  } catch {
    // Sharing still works with fallback fonts.
  }
}

async function waitForImages(root) {
  const images = [...root.querySelectorAll("img")].filter((image) => !image.complete);
  await Promise.all(
    images.map(
      (image) =>
        new Promise((resolve) => {
          image.addEventListener("load", resolve, { once: true });
          image.addEventListener("error", resolve, { once: true });
        }),
    ),
  );
}

function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }

      reject(new Error("Could not create share image."));
    }, "image/png");
  });
}

function isLikelyPhone() {
  const coarsePointer = window.matchMedia?.("(pointer: coarse)")?.matches;
  const narrowViewport = window.matchMedia?.("(max-width: 760px)")?.matches;
  const shortEdge = Math.min(window.screen?.width || window.innerWidth, window.screen?.height || window.innerHeight);
  return Boolean(coarsePointer && narrowViewport && shortEdge <= 820);
}

function canShareFile(file) {
  try {
    return Boolean(navigator.share && navigator.canShare?.({ files: [file] }));
  } catch {
    return false;
  }
}

async function copyPngToClipboard(blob) {
  if (!navigator.clipboard || !window.ClipboardItem) return false;

  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        [blob.type]: blob,
      }),
    ]);
    return true;
  } catch {
    return false;
  }
}

function downloadBlob(blob, fileName) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 500);
}

function baseFileName(name) {
  return String(name || "schedule").replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "-");
}

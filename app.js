const { createApp, nextTick } = Vue;

const ROSTER_CACHE_KEY = "schedulePhotoReader.roster.v1";
const PROFILE_CACHE_KEY = "schedulePhotoReader.profile.v1";
const NAME_CACHE_KEY = "schedulePhotoReader.nameAliases.v1";
const EVENT_CACHE_KEY = "schedulePhotoReader.dateEvents.v1";
const DAY_TRANSITION_MS = 260;
const DAY_FAST_TRANSITION_MS = 36;
const DAY_FAST_FRAME_GAP_MS = 6;
const DAY_FAST_MAX_HOPS = 6;
const SHIFT_PANDA_IMAGES = Object.freeze({
  work: "assets/shift-panda-work.png",
  late: "assets/shift-panda-late.png",
  off: "assets/shift-panda-off.png",
});

createApp({
  data() {
    return {
      selectedFile: null,
      previewUrl: "",
      isDragging: false,
      isProcessing: false,
      progress: 0,
      statusText: "Upload Photo",
      table: [],
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
      showSpreadsheet: false,
      pendingReplace: false,
      readError: false,
      runId: 0,
      serverAuth: "not configured",
      googleApiKey: "",
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
  },
  methods: {
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

        const imageBase64 = await fileToBase64(this.selectedFile);
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
            mimeType: this.selectedFile.type,
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

        const mappedTable = grid.isUsable ? wordsToTable(result.words || [], grid) : [];
        const fallbackTable = textToTable(result.text || "");
        const bestTable =
          countFilledCells(mappedTable) >= Math.max(8, countFilledCells(fallbackTable) * 0.35)
            ? mappedTable
            : fallbackTable;

        this.table = padRows(trimEmptyEdges(bestTable));
        const rosterDb = createRosterDatabase(this.table, this.selectedFile.name);

        if (!rosterDb.profiles.length) {
          this.showSpreadsheet = true;
          this.statusText = "Spreadsheet ready, but no worker profiles were found";
          this.progress = 100;
          return;
        }

        this.setRosterDb(rosterDb);
        this.progress = 100;
        this.statusText = `Roster saved with ${rosterDb.profiles.length} profiles`;
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
      const rosterDb = createRosterDatabase(this.table, sourceName);
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
      this.progress = 0;
      this.isProcessing = false;
      this.readError = false;
      this.showSpreadsheet = false;
      this.pendingReplace = false;
      this.dateEvents = {};
      this.eventEditorShift = null;
      this.eventEditorValue = "";
      removeCache(EVENT_CACHE_KEY);
      this.statusText = "Upload Photo";
    },
    clearCachedRosterOnly() {
      removeCache(ROSTER_CACHE_KEY);
      removeCache(PROFILE_CACHE_KEY);
      this.rosterDb = null;
      this.selectedProfileId = "";
      this.profilePickerIndex = 0;
      this.selectedShiftIndex = 0;
      this.coworkerModalShift = null;
      this.eventEditorShift = null;
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
    openDateEventEditor(shift = this.activeShift) {
      if (!shiftEventKey(shift)) return;
      this.closeCoworkerModal();
      this.closeNameEditor();
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

function createRosterDatabase(table, sourceFileName = "") {
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
  return confidence <= 1 ? confidence >= 0.2 : confidence >= 20;
}

function findCellIndex(lines, point) {
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (point >= lines[index] && point < lines[index + 1]) return index;
  }

  return -1;
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
  const rows = table.filter((row) => row.some((cell) => String(cell).trim()));
  if (!rows.length) return [];

  const lastColumn = rows.reduce((max, row) => {
    for (let index = row.length - 1; index >= 0; index -= 1) {
      if (String(row[index] || "").trim()) return Math.max(max, index);
    }
    return max;
  }, 0);

  return rows.map((row) => row.slice(0, lastColumn + 1));
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
    .replace(/\b(\d{1,2})\s*CON\b/g, "$1 CON");

  if (/^(OFF|ROFF|SAL|AL|\d{1,2}|\d{1,2}\.\d|\d{1,2}-\d{1,2}|\d{1,2} \(TR\)|\d{1,2} CON|\/)$/.test(corrected)) {
    return corrected;
  }

  if (/^\d{1,2}-[A-Z]{3}$/.test(corrected)) {
    return corrected.replace(/-([A-Z]{3})$/, (_, month) => {
      return `-${month[0]}${month.slice(1).toLowerCase()}`;
    });
  }

  return text;
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

function baseFileName(name) {
  return String(name || "schedule").replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "-");
}

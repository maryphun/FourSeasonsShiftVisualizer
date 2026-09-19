/* Presentation components: atoms, molecules, then dashboard organisms. */
(() => {
  const { h } = Vue;

  const UiIcon = {
    props: { name: { type: String, required: true } },
    render() {
      const key = this.name.replace(/(^|-)([a-z])/g, (_, prefix, letter) => letter.toUpperCase());
      const nodes = window.lucide?.icons?.[key] || [];
      return h("svg", {
        xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 24 24", width: 20, height: 20,
        fill: "none", stroke: "currentColor", "stroke-width": 1.7,
        "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true",
        class: "shrink-0",
      }, nodes.map(([tag, attributes]) => h(tag, attributes)));
    },
  };

  const UiAction = {
    components: { UiIcon },
    props: { icon: String, label: String, iconOnly: Boolean },
    template: `<button type="button" class="ui-action inline-flex items-center justify-center gap-2 rounded-lg"
      :aria-label="iconOnly ? label : undefined" :title="iconOnly ? label : undefined">
      <ui-icon v-if="icon" :name="icon"></ui-icon><span v-if="!iconOnly"><slot>{{ label }}</slot></span>
    </button>`,
  };

  const ShiftDateBadge = {
    props: { day: Number, weekday: String, dateKey: String },
    template: `<time class="shift-date-badge" :datetime="dateKey"><strong>{{ day }}</strong><span>{{ weekday }}</span></time>`,
  };

  const ShiftReading = {
    props: { main: String, context: String },
    template: `<div class="day-shift-display" :class="{ 'has-context': context, 'is-long': main.length > 5 }">
      <strong>{{ main }}</strong><small v-if="context">{{ context }}</small>
    </div>`,
  };

  const MonthNavigation = {
    components: { UiAction },
    props: { label: String, atStart: Boolean, atEnd: Boolean },
    emits: ["change"],
    template: `<nav class="month-navigation flex min-w-0 items-center gap-2" aria-label="Calendar month">
      <ui-action class="month-arrow" icon="chevron-left" label="Previous month" icon-only :disabled="atStart" @click="$emit('change', -1)"></ui-action>
      <span class="month-label text-center font-semibold tabular-nums" aria-live="polite">{{ label }}</span>
      <ui-action class="month-arrow" icon="chevron-right" label="Next month" icon-only :disabled="atEnd" @click="$emit('change', 1)"></ui-action>
    </nav>`,
  };

  const ShiftCard = {
    components: { ShiftDateBadge, ShiftReading, UiIcon },
    props: { shift: Object, slotName: String, appearance: Object, panda: String,
      relative: String, main: String, context: String, weekday: String, eventText: String, coworkers: Number },
    emits: ["navigate", "coworkers"],
    template: `<article class="day-shift-card day-carousel-card" :class="[appearance, 'is-' + slotName]"
      :aria-hidden="slotName !== 'active'" @click="$emit('navigate', slotName)">
      <img v-if="panda" class="day-shift-panda" :src="panda" alt="" aria-hidden="true" draggable="false" />
      <div class="day-card-topline"><span>{{ relative }}</span><small>{{ shift.dateLabel }}</small></div>
      <div class="day-card-main">
        <shift-date-badge :day="shift.day" :weekday="weekday" :date-key="shift.dateKey"></shift-date-badge>
        <shift-reading :main="main" :context="context"></shift-reading>
      </div>
      <div class="day-card-action">
        <p class="day-event-note" :class="{ 'is-empty': !eventText }" :aria-hidden="!eventText" :title="eventText">{{ eventText || 'No event' }}</p>
        <div class="day-card-coworkers">
          <button v-if="slotName === 'active' && coworkers" class="coworker-button" type="button" @click.stop="$emit('coworkers', shift)">
            <ui-icon name="users"></ui-icon><span>{{ coworkers }} other persons</span><ui-icon name="chevron-right"></ui-icon>
          </button>
          <span v-else-if="coworkers" class="coworker-count-label"><ui-icon name="users"></ui-icon><span>{{ coworkers }} other persons</span><ui-icon name="chevron-right"></ui-icon></span>
        </div>
      </div>
    </article>`,
  };

  const MonthCalendar = {
    props: { days: Array, selectedIndex: Number, today: String, startColumn: Number },
    emits: ["select"],
    methods: {
      moveFocus(event, index) {
        const offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
        let next = index + (offsets[event.key] || 0);
        if (event.key === "Home") next = 0;
        else if (event.key === "End") next = this.days.length - 1;
        else if (!(event.key in offsets)) return;
        event.preventDefault();
        next = Math.max(0, Math.min(this.days.length - 1, next));
        this.$el.querySelectorAll(".day-pill")[next]?.focus();
        this.$emit("select", next);
      },
    },
    template: `<div class="month-calendar" :style="{ '--calendar-weeks': Math.ceil((startColumn - 1 + days.length) / 7) }">
      <div class="calendar-weekdays grid grid-cols-7" aria-hidden="true"><span v-for="day in ['月','火','水','木','金','土','日']" :key="day">{{ day }}</span></div>
      <div class="day-pills grid grid-cols-7 gap-1" aria-label="Month days">
        <button v-for="(day, index) in days" :key="day.dateKey" class="day-pill"
          :class="{ active: index === selectedIndex, today: day.dateKey === today, leave: day.leave, 'is-late': day.late, 'has-event': Boolean(day.event), 'is-unplanned': day.isPlaceholder }"
          :style="index === 0 ? { gridColumnStart: startColumn } : null" :aria-pressed="index === selectedIndex"
          :aria-current="day.dateKey === today ? 'date' : undefined"
          :aria-label="[day.dateKey, day.main, day.context, day.event].filter(Boolean).join(': ')" type="button"
          @click="$emit('select', index)" @keydown="moveFocus($event, index)">
          <span class="calendar-day-number">{{ day.day }}</span>
          <span class="calendar-shift-time" aria-hidden="true">{{ day.main }}</span>
          <span v-if="day.event" class="calendar-event-mark" aria-hidden="true"></span>
        </button>
      </div>
    </div>`,
  };

  const MonthlySummary = {
    props: { items: Array },
    template: `<dl class="summary-strip monthly-summary" aria-label="This month's totals">
      <div v-for="item in items" :key="item.label" class="summary-item" :class="item.tone">
        <dt>{{ item.label }}</dt><dd class="tabular-nums">{{ item.value }}</dd>
      </div>
    </dl>`,
  };

  window.ScheduleUI = { UiIcon, UiAction, ShiftDateBadge, ShiftReading, MonthNavigation, ShiftCard, MonthCalendar, MonthlySummary };

  const dialogs = [];
  window.ScheduleDialogFocus = {
    mounted(element, binding) {
      const state = { element, previous: document.activeElement };
      const previousDialog = dialogs.at(-1);
      if (previousDialog) previousDialog.element.inert = true;
      dialogs.push(state);
      document.querySelector("main")?.setAttribute("inert", "");
      element.tabIndex = -1;
      state.onKey = (event) => {
        if (dialogs.at(-1) !== state) return;
        if (event.key === "Escape") {
          event.preventDefault();
          binding.value();
        } else if (event.key === "Tab") {
          const controls = [...element.querySelectorAll("button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex='0']")]
            .filter((control) => control.getClientRects().length);
          const first = controls[0] || element;
          const last = controls.at(-1) || element;
          if (event.shiftKey && (document.activeElement === first || document.activeElement === element)) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === element)) {
            event.preventDefault();
            first.focus();
          }
        }
      };
      element.__dialogFocus = state;
      document.addEventListener("keydown", state.onKey);
      Vue.nextTick(() => {
        if (dialogs.at(-1) === state && !element.contains(document.activeElement)) {
          (element.querySelector("input, select, button") || element).focus({ preventScroll: true });
        }
      });
    },
    unmounted(element) {
      const state = element.__dialogFocus;
      document.removeEventListener("keydown", state.onKey);
      dialogs.splice(dialogs.indexOf(state), 1);
      const current = dialogs.at(-1);
      if (current) current.element.inert = false;
      else document.querySelector("main")?.removeAttribute("inert");
      if (state.previous?.isConnected && (!current || current.element.contains(state.previous))) {
        state.previous.focus({ preventScroll: true });
      }
    },
  };
})();

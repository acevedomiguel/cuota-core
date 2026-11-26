/* Appearance control (the sidebar toggle and the Settings radios).
   The stored choice is per browser, so no account or server state is involved.
   Only an explicit "light"/"dark" override is stored; System removes the entry
   and lets the device preference take over again. The early inline bootstrap in
   _head.ejs already applied the stored value before first paint — this script
   only reflects it in the controls, applies new choices, and keeps other tabs in
   sync. */
(function () {
  "use strict";

  var KEY = "cuota-color-scheme";
  var CHOICES = ["system", "light", "dark"];
  var NAMES = {
    system: "Theme: Auto (system). Switch to Light.",
    light: "Theme: Light. Switch to Dark.",
    dark: "Theme: Dark. Switch to Auto.",
  };
  var ANNOUNCEMENTS = {
    system: "Theme set to Auto (system).",
    light: "Theme set to Light.",
    dark: "Theme set to Dark.",
  };
  var darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

  function meta() {
    return document.querySelector('meta[name="color-scheme"]');
  }

  /** The state the bootstrap left in the meta tag. */
  function currentChoice() {
    var tag = meta();
    var content = tag ? tag.getAttribute("content") : "light dark";
    return content === "light" || content === "dark" ? content : "system";
  }

  function radios() {
    return document.querySelectorAll('input[name="color-scheme"]');
  }

  function markControl(choice) {
    var inputs = radios();
    for (var i = 0; i < inputs.length; i++) {
      inputs[i].checked = inputs[i].value === choice;
    }
  }

  function markSystemLabel() {
    var label = document.querySelector("[data-system-theme]");
    if (!label) return;
    label.textContent = "System (currently " + (darkQuery.matches ? "dark" : "light") + ")";
  }

  /** Reflects the choice in the sidebar toggle: one icon, name and tooltip. */
  function markToggle(choice) {
    var button = document.querySelector("[data-theme-toggle]");
    if (!button) return;
    var icons = button.querySelectorAll("[data-theme-icon]");
    for (var i = 0; i < icons.length; i++) {
      /* SVGElement has no `hidden` IDL property and the UA's `[hidden]` rule
         does not match SVG-namespace elements, so toggle the content attribute
         and let the scoped stylesheet rule hide it. */
      icons[i].toggleAttribute("hidden", icons[i].getAttribute("data-theme-icon") !== choice);
    }
    var name = NAMES[choice] || NAMES.system;
    button.setAttribute("aria-label", name);
    button.setAttribute("title", name);
  }

  function announceChange(choice) {
    var status = document.querySelector("[data-theme-status]");
    if (!status) return;
    status.textContent = ANNOUNCEMENTS[choice] || ANNOUNCEMENTS.system;
  }

  /** Applies a choice to the page. Storage failures never block the theme. */
  function apply(choice, persist, announce) {
    var tag = meta();
    if (!tag) return;
    tag.setAttribute("content", choice === "light" || choice === "dark" ? choice : "light dark");
    markControl(choice);
    markToggle(choice);
    markSystemLabel();
    if (announce) announceChange(choice);
    if (!persist) return;
    try {
      if (choice === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, choice);
    } catch (error) {
      /* storage blocked: the page still uses the chosen theme for this visit */
    }
  }

  function onControlChange(event) {
    var target = event.target;
    if (!target || target.name !== "color-scheme") return;
    var choice = CHOICES.indexOf(target.value) > -1 ? target.value : "system";
    apply(choice, true, true);
  }

  /* The button cycles System -> Light -> Dark -> System, reading the current
     state from the meta tag so it always continues from what is on screen. */
  function onToggleClick() {
    var index = CHOICES.indexOf(currentChoice());
    apply(CHOICES[(index + 1) % CHOICES.length], true, true);
  }

  /* Another tab changed the choice. Only explicit Light/Dark values map to an
     override; a removal (or anything unexpected) means System again. */
  function onStorage(event) {
    if (event.key !== KEY && event.key !== null) return;
    var value = event.newValue;
    apply(value === "light" || value === "dark" ? value : "system", false, true);
  }

  /* Keep the System hint current. It describes the device, so it is refreshed
     on every device preference change — including while an explicit override is
     active. The override itself is never changed or removed here, and the
     toggle keeps showing the chosen state rather than the device one. */
  function onSystemPreferenceChange() {
    markSystemLabel();
  }

  function start() {
    apply(currentChoice(), false);
    var toggle = document.querySelector("[data-theme-toggle]");
    if (toggle) toggle.addEventListener("click", onToggleClick);
    var fieldset = document.querySelector("[data-theme-control]");
    if (fieldset) fieldset.addEventListener("change", onControlChange);
    window.addEventListener("storage", onStorage);
    if (typeof darkQuery.addEventListener === "function") {
      darkQuery.addEventListener("change", onSystemPreferenceChange);
    } else if (typeof darkQuery.addListener === "function") {
      darkQuery.addListener(onSystemPreferenceChange);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();

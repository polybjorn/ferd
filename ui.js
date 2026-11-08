/* ui.js 1.13.0: the behaviour behind the ui.css menu and search blocks, for
   an app that wants it rather than its own.

   Load it as a plain deferred script, <script src="ui.js" defer></script>,
   which a module page can load too, and which runs under script-src 'self'.
   It defines one global, uiFoundation, and nothing else.

   A menu needs no script of the app's own: a button with
   aria-haspopup="menu", aria-expanded="false" and aria-controls naming a
   .ui-menu opens it on click, ArrowDown or ArrowUp. Opening closes any other
   menu and moves focus to the first enabled item, or the last for ArrowUp.
   A click outside, Escape, Tab and choosing a menuitem close it; closing
   returns focus to the trigger unless the choice moved it somewhere else.
   A menuitemcheckbox toggles aria-checked and stays open. A menuitemradio
   checks itself, unchecks the rest of its role="group" or menu, and closes.
   Arrow keys move through the enabled items and wrap; Home, End and typing
   the start of a label move too. A menu opened inside an open dialog is moved
   into that dialog and placed with .ui-menu-at from its trigger's box, then
   put back where it was on close.

   uiFoundation.openMenuAt(menu, x, y, origin) opens a menu at a point, for a
   context menu, kept 8px inside the viewport and flipped above or to the
   start when it does not fit. Focus returns to origin, by default the element
   focused before. uiFoundation.openMenu(trigger) and
   uiFoundation.closeMenu() do from code what the markup does.

   A .ui-search form that resets, from its clear button or from form.reset(),
   fires one input event on its field once the field has cleared, so a filter
   that listens for input alone sees the empty query. A reset from the clear
   button then puts focus in the field, unless a listener moved it somewhere
   else. A reset the host prevented does neither. */
(() => {
  "use strict";
  if (window.uiFoundation) return;

  const ITEM = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]';
  const TRIGGER = '[aria-haspopup="menu"], [aria-haspopup="true"]';
  const EDGE = 8;
  // Long enough to type a word, short enough that a pause starts a new one.
  const TYPEAHEAD_MS = 500;

  let current = null;
  let typed = "";
  let typedAt = 0;

  const enabled = (el) => !el.disabled && el.getAttribute("aria-disabled") !== "true"
    && el.getClientRects().length > 0;
  const itemsOf = (menu) => [...menu.querySelectorAll(ITEM)].filter(enabled);

  function menuOf(trigger) {
    const id = trigger.getAttribute("aria-controls");
    const menu = id && document.getElementById(id);
    return menu && menu.classList.contains("ui-menu") ? menu : null;
  }

  // The gap ui.css leaves between an anchored menu and its trigger.
  function gap(menu) {
    const v = getComputedStyle(menu).getPropertyValue("--ui-space-1").trim();
    const n = parseFloat(v);
    if (Number.isNaN(n)) return 4;
    return v.endsWith("rem") ? n * parseFloat(getComputedStyle(document.documentElement).fontSize) : n;
  }

  // x and y are the menu's left and top edges, alternatives the flipped ones.
  // The custom properties are inset-inline-start, which is the right edge in
  // a right-to-left page.
  function put(menu, x, y, altX, altY) {
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const { width: w, height: h } = menu.getBoundingClientRect();
    if (x + w > vw - EDGE && altX >= EDGE) x = altX;
    else if (x < EDGE && altX + w <= vw - EDGE) x = altX;
    if (y + h > vh - EDGE && altY >= EDGE) y = altY;
    x = Math.max(EDGE, Math.min(x, vw - EDGE - w));
    y = Math.max(EDGE, Math.min(y, vh - EDGE - h));
    const rtl = getComputedStyle(menu).direction === "rtl";
    menu.style.setProperty("--ui-menu-x", (rtl ? vw - x - w : x) + "px");
    menu.style.setProperty("--ui-menu-y", y + "px");
  }

  function putAtPoint(menu, x, y) {
    const { width: w, height: h } = menu.getBoundingClientRect();
    if (getComputedStyle(menu).direction === "rtl") put(menu, x - w, y, x, y - h);
    else put(menu, x, y, x - w, y - h);
  }

  function putFromTrigger(menu, trigger) {
    const r = trigger.getBoundingClientRect();
    const { width: w, height: h } = menu.getBoundingClientRect();
    const g = gap(menu);
    const rtl = getComputedStyle(menu).direction === "rtl";
    const start = rtl ? r.right - w : r.left;
    const end = rtl ? r.left : r.right - w;
    let x = start;
    let altX = end;
    if (menu.classList.contains("ui-menu-end")) [x, altX] = [end, start];
    else if (menu.classList.contains("ui-menu-center")) x = altX = r.left + (r.width - w) / 2;
    put(menu, x, r.bottom + g, altX, r.top - g - h);
  }

  function focusItem(menu, which) {
    const items = itemsOf(menu);
    const item = which === "last" ? items[items.length - 1] : items[0];
    // A placed menu is inside the viewport already; scrolling would move the
    // trigger away from it.
    if (item) item.focus({ preventScroll: menu.classList.contains("ui-menu-at") });
  }

  function show(menu, trigger, returnTo, at) {
    close(false);
    // A modal dialog makes the rest of the page inert, and its overflow clips
    // an absolute menu, so the menu goes inside it and is fixed.
    const dialog = (trigger || returnTo)?.closest?.("dialog[open]");
    const placed = Boolean(at || dialog || menu.classList.contains("ui-menu-at"));
    const state = { menu, trigger, returnTo, placed, home: null, addedAt: false };
    if (dialog && !dialog.contains(menu)) {
      state.home = { parent: menu.parentNode, next: menu.nextSibling };
      dialog.append(menu);
    }
    if (placed && !menu.classList.contains("ui-menu-at")) {
      menu.classList.add("ui-menu-at");
      state.addedAt = true;
    }
    menu.hidden = false;
    current = state;
    if (trigger) trigger.setAttribute("aria-expanded", "true");
    if (placed) {
      if (at) putAtPoint(menu, at.x, at.y);
      else putFromTrigger(menu, trigger);
    }
  }

  function close(returnFocus) {
    const s = current;
    if (!s) return;
    current = null;
    typed = "";
    const hadFocus = s.menu.contains(document.activeElement);
    s.menu.hidden = true;
    if (s.trigger) s.trigger.setAttribute("aria-expanded", "false");
    if (s.placed) {
      s.menu.style.removeProperty("--ui-menu-x");
      s.menu.style.removeProperty("--ui-menu-y");
    }
    if (s.addedAt) s.menu.classList.remove("ui-menu-at");
    if (s.home) {
      const { parent, next } = s.home;
      parent.insertBefore(s.menu, next && next.parentNode === parent ? next : null);
    }
    const target = s.trigger || s.returnTo;
    // A choice that opened a dialog or moved focus itself keeps it there.
    const focusLeft = !document.activeElement || document.activeElement === document.body;
    if (returnFocus && target && target.isConnected && (hadFocus || focusLeft)) {
      target.focus({ preventScroll: true });
    }
  }

  function openMenu(trigger, which) {
    const menu = menuOf(trigger);
    if (!menu) return;
    show(menu, trigger, null, null);
    focusItem(menu, which);
  }

  function openMenuAt(menu, x, y, origin) {
    const from = origin || document.activeElement;
    show(menu, null, from && from !== document.body ? from : null, { x, y });
    focusItem(menu, "first");
  }

  function choose(item) {
    const role = item.getAttribute("role");
    if (role === "menuitemcheckbox") {
      item.setAttribute("aria-checked", String(item.getAttribute("aria-checked") !== "true"));
      return;
    }
    if (role === "menuitemradio") {
      const group = item.closest('[role="group"]') || current.menu;
      for (const r of group.querySelectorAll('[role="menuitemradio"]')) {
        r.setAttribute("aria-checked", String(r === item));
      }
    }
    close(true);
  }

  function typeahead(menu, from, key) {
    const now = Date.now();
    typed = now - typedAt > TYPEAHEAD_MS ? key : typed + key;
    typedAt = now;
    const items = itemsOf(menu);
    // Pressing one letter again steps through the items that start with it.
    const repeat = [...typed].every((c) => c === typed[0]);
    const text = repeat ? typed[0] : typed;
    const start = repeat || from < 0 ? from + 1 : from;
    for (let i = 0; i < items.length; i++) {
      const item = items[(start + i) % items.length];
      if (item.textContent.trim().toLowerCase().startsWith(text.toLowerCase())) {
        item.focus();
        return;
      }
    }
  }

  function menuKey(e) {
    const menu = current.menu;
    const items = itemsOf(menu);
    const item = e.target.closest(ITEM);
    const i = items.indexOf(item);
    const n = items.length;
    let to = null;
    switch (e.key) {
      case "ArrowDown": to = items[(i + 1) % n]; break;
      case "ArrowUp": to = items[i < 0 ? n - 1 : (i - 1 + n) % n]; break;
      case "Home": to = items[0]; break;
      case "End": to = items[n - 1]; break;
      case "Escape": close(true); break;
      // No preventDefault: with focus back on the trigger, the browser's own
      // Tab moves on from there.
      case "Tab": close(true); return;
      case "Enter":
      case " ":
        if (!item || item.tagName === "BUTTON") return;
        item.click();
        break;
      default:
        if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
        typeahead(menu, i, e.key);
    }
    if (to) to.focus();
    // A handled key ends here, so a dialog behind the menu does not close on
    // Escape and a page's own arrow keys do not act under the menu.
    e.preventDefault();
    e.stopPropagation();
  }

  document.addEventListener("keydown", (e) => {
    if (!(e.target instanceof Element)) return;
    if (current && current.menu.contains(e.target)) {
      menuKey(e);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const trigger = e.target.closest(TRIGGER);
    if (!trigger || !menuOf(trigger)) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (current && current.trigger === trigger) focusItem(current.menu, e.key === "ArrowUp" ? "last" : "first");
      else openMenu(trigger, e.key === "ArrowUp" ? "last" : "first");
    } else if (e.key === "Escape" && current && current.trigger === trigger) {
      close(true);
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  }, true);

  // Capture, so a choice is made before the item's own click listener reads
  // aria-checked, and still made when that listener stops propagation.
  document.addEventListener("click", (e) => {
    if (!(e.target instanceof Element)) return;
    const item = current && e.target.closest(ITEM);
    if (item && current.menu.contains(item)) {
      if (enabled(item)) choose(item);
      else e.preventDefault();
      return;
    }
    const trigger = e.target.closest(TRIGGER);
    if (!trigger || !menuOf(trigger)) return;
    if (current && current.trigger === trigger) close(true);
    else openMenu(trigger, "first");
  }, true);

  document.addEventListener("pointerdown", (e) => {
    if (!current) return;
    const t = e.target;
    if (current.menu.contains(t) || (current.trigger && current.trigger.contains(t))) return;
    close(false);
  }, true);

  // Focus moved out by other means than a key or a click here, such as a
  // screen reader. A null relatedTarget is the window losing focus, which
  // leaves the menu as it was.
  document.addEventListener("focusout", (e) => {
    const to = e.relatedTarget;
    if (!current || !to || current.menu.contains(to) || to === current.trigger) return;
    close(false);
  });

  // A placed menu is fixed, so it would stay put while the page under it
  // moves.
  const dropPlaced = (e) => {
    if (!current || !current.placed) return;
    if (e.type === "scroll" && e.target instanceof Node && current.menu.contains(e.target)) return;
    close(true);
  };
  window.addEventListener("resize", dropPlaced);
  document.addEventListener("scroll", dropPlaced, true);

  // The clear button's click runs the reset, so its reset event follows
  // within the same task; a click whose reset never comes is forgotten after.
  let clearing = null;
  document.addEventListener("click", (e) => {
    const button = e.target instanceof Element && e.target.closest(".ui-search-clear");
    if (!button) return;
    clearing = button;
    setTimeout(() => { clearing = null; });
  }, true);

  // The field clears after the reset event, not during it, so the input event
  // waits a task, which also lets a later listener prevent the reset.
  document.addEventListener("reset", (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement) || !form.classList.contains("ui-search")) return;
    const field = form.querySelector('input[type="search"]');
    if (!field) return;
    const before = field.value;
    const button = clearing && form.contains(clearing) ? clearing : null;
    clearing = null;
    setTimeout(() => {
      if (e.defaultPrevented) return;
      if (field.value !== before) field.dispatchEvent(new Event("input", { bubbles: true }));
      const at = document.activeElement;
      if (button && !field.disabled && (!at || at === document.body || at === button)) field.focus();
    });
 }, true);

  window.uiFoundation = Object.freeze({
    openMenu: (trigger) => openMenu(trigger, "first"),
    openMenuAt,
    closeMenu: () => close(true),
  });
})();

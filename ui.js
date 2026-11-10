/* ui.js 1.17.0: the behaviour behind the ui.css blocks that need script,
   menus, search, dialogs, collapses, popovers and tabs, and a toast and a
   confirm built from them, for an app that wants it rather than its own.

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
   put back where it was on close. An anchored menu that would cross an
   inline edge of the viewport is shifted back 8px inside it with an inline
   translate, again on resize while open, and the shift is cleared on close.

   uiFoundation.openMenuAt(menu, x, y, origin) opens a menu at a point, for a
   context menu, kept 8px inside the viewport and flipped above or to the
   start when it does not fit. Focus returns to origin, by default the element
   focused before. uiFoundation.openMenu(trigger) and
   uiFoundation.closeMenu() do from code what the markup does.

   A .ui-search form that resets, from its clear button or from form.reset(),
   fires one input event on its field once the field has cleared, so a filter
   that listens for input alone sees the empty query. A reset from the clear
   button then puts focus in the field, unless a listener moved it somewhere
   else. A reset the host prevented does neither.

   A .ui-dialog the host opens with showModal() takes three attributes, none
   needing script of the app's own. data-ui-backdrop closes it on a click that
   started and ended on the backdrop, as a close request: the dialog's cancel
   event fires first and a listener that prevents it keeps the dialog open.
   data-ui-phone="sheet", "fullscreen" or "top" adds ui-dialog-sheet,
   ui-dialog-fullscreen or ui-dialog-top while the viewport is 600px wide or
   less, on opening and again when the width crosses that line. Any dialog
   gets focus back on the element the user last acted on before it opened,
   when the browser left focus on the page rather than on that element.

   A button with aria-expanded and aria-controls naming a .ui-collapse opens
   and closes it on click, toggling .open and setting aria-expanded on every
   button that names it. An app whose own click listener toggles .open is not
   toggled back, and a click it prevents or stops is left to it. An app that
   drives the panel from its own state still sets .open itself.

   A button with aria-expanded and aria-controls naming a .ui-popover opens and
   closes it on click, toggling hidden and setting aria-expanded on every
   button that names it. A press outside it and Escape close it, Escape
   returning focus to the opening button; opening a popover or a menu closes
   the other. A press inside a listbox, menu, tree or grid that a control in
   the popover has opened (aria-expanded, aria-controls or aria-owns) counts
   as inside. Escape is read after the page's own handlers, so a control that
   handles or prevents it keeps it, and a popover in an open modal dialog
   closes without the dialog. An app whose own click listener toggles hidden
   is not toggled back, and a click it prevents or stops is left to it.

   A role="tablist" of role="tab" buttons (.ui-tab) selects on click and moves
   with the arrow keys, Home and End. Left and Right move in the reading
   direction, so they swap in a right-to-left page; a tablist with
   aria-orientation="vertical" takes Up and Down instead. Moving wraps, skips
   a disabled tab and selects the tab it lands on, by clicking it, so an app's
   own click listener hears a key move too. Selecting sets aria-selected and a
   roving tabindex on the row and shows the panel each tab's aria-controls
   names while hiding the others. The markup sets the first state: the tab
   with aria-selected="true", tabindex="-1" on the rest and hidden on the
   other panels. An app that sets aria-selected itself, from its own state,
   is not fought: the script reads the row as it finds it, and a click the
   app prevents is left to it.

   uiFoundation.toast(text, { action, timeout }) shows a message in one
   .ui-toast live region that it adds to the body on first use, and replaces
   whatever toast was showing. action is { label, onClick }: a quiet
   .ui-button that runs onClick and dismisses the toast. A toast with an
   action has no timer; one without hides after timeout milliseconds, 4500 by
   default, and timeout: 0 keeps it until the next toast.

   uiFoundation.confirm({ title, body, confirmLabel, cancelLabel, danger })
   opens a modal .ui-dialog, a sheet on a phone, and returns a promise of a
   boolean: true for the confirm button or Enter, false for the cancel
   button, Escape or a click on the backdrop. danger styles the confirm button
   as ui-button-danger. Focus starts on the confirm button and returns to the
   element the user last acted on. title and body are text, never markup. */
(() => {
  "use strict";
  if (window.uiFoundation) return;

  const ITEM = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]';
  const TRIGGER = '[aria-haspopup="menu"], [aria-haspopup="true"]';
  const EDGE = 8;
  // Long enough to type a word, short enough that a pause starts a new one.
  const TYPEAHEAD_MS = 500;

  /**
   * The open menu, and what closing it has to undo.
   * @typedef {object} MenuState
   * @property {HTMLElement} menu
   * @property {Element | null} trigger
   * @property {Element | null} returnTo
   * @property {boolean} placed
   * @property {{ parent: ParentNode | null, next: ChildNode | null } | null} home
   * @property {boolean} addedAt
   */

  /** @type {MenuState | null} */
  let current = null;
  let typed = "";
  let typedAt = 0;

  /** @param {Element} el */
  const enabled = (el) => !(/** @type {HTMLButtonElement} */ (el).disabled) && el.getAttribute("aria-disabled") !== "true"
    && el.getClientRects().length > 0;
  /**
   * @param {Element} menu
   * @returns {HTMLElement[]}
   */
  const itemsOf = (menu) => [.../** @type {NodeListOf<HTMLElement>} */ (menu.querySelectorAll(ITEM))].filter(enabled);

  /**
   * @param {Element} trigger
   * @returns {HTMLElement | null}
   */
  function menuOf(trigger) {
    const id = trigger.getAttribute("aria-controls");
    const menu = id && document.getElementById(id);
    return menu && menu.classList.contains("ui-menu") ? menu : null;
  }

  // The gap ui.css leaves between an anchored menu and its trigger.
  /** @param {Element} menu */
  function gap(menu) {
    const v = getComputedStyle(menu).getPropertyValue("--ui-space-1").trim();
    const n = parseFloat(v);
    if (Number.isNaN(n)) return 4;
    return v.endsWith("rem") ? n * parseFloat(getComputedStyle(document.documentElement).fontSize) : n;
  }

  // x and y are the menu's left and top edges, alternatives the flipped ones.
  // The custom properties are inset-inline-start, which is the right edge in
  // a right-to-left page.
  /**
   * @param {HTMLElement} menu
   * @param {number} x
   * @param {number} y
   * @param {number} altX
   * @param {number} altY
   */
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

  /**
   * @param {HTMLElement} menu
   * @param {number} x
   * @param {number} y
   */
  function putAtPoint(menu, x, y) {
    const { width: w, height: h } = menu.getBoundingClientRect();
    if (getComputedStyle(menu).direction === "rtl") put(menu, x - w, y, x, y - h);
    else put(menu, x, y, x - w, y - h);
  }

  /**
   * @param {HTMLElement} menu
   * @param {Element} trigger
   */
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

  // An anchored menu is placed by ui.css alone, so nothing else keeps it on
  // screen. The translate is physical, as the measure is, and leaves the
  // block placement under the trigger. A menu too wide for the viewport keeps
  // its start edge.
  /** @param {HTMLElement} menu */
  function nudge(menu) {
    menu.style.removeProperty("translate");
    const vw = document.documentElement.clientWidth;
    const { left, right } = menu.getBoundingClientRect();
    let dx = 0;
    if (getComputedStyle(menu).direction === "rtl") {
      if (left < EDGE) dx = EDGE - left;
      if (right + dx > vw - EDGE) dx = vw - EDGE - right;
    } else {
      if (right > vw - EDGE) dx = vw - EDGE - right;
      if (left + dx < EDGE) dx = EDGE - left;
    }
    if (dx) menu.style.setProperty("translate", dx + "px 0");
  }

  /**
   * @param {Element} menu
   * @param {"first" | "last"} which
   */
  function focusItem(menu, which) {
    const items = itemsOf(menu);
    const item = which === "last" ? items[items.length - 1] : items[0];
    // A placed menu is inside the viewport already; scrolling would move the
    // trigger away from it.
    if (item) item.focus({ preventScroll: menu.classList.contains("ui-menu-at") });
  }

  /**
   * @param {HTMLElement} menu
   * @param {Element | null} trigger
   * @param {Element | null} returnTo
   * @param {{ x: number, y: number } | null} at
   */
  function show(menu, trigger, returnTo, at) {
    close(false);
    // A modal dialog makes the rest of the page inert, and its overflow clips
    // an absolute menu, so the menu goes inside it and is fixed.
    const dialog = (trigger || returnTo)?.closest?.("dialog[open]");
    const placed = Boolean(at || dialog || menu.classList.contains("ui-menu-at"));
    /** @type {MenuState} */
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
      // Only openMenu places without a point, and it always has a trigger.
      else putFromTrigger(menu, /** @type {Element} */ (trigger));
    } else nudge(menu);
  }

  /** @param {boolean} returnFocus */
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
    } else s.menu.style.removeProperty("translate");
    if (s.addedAt) s.menu.classList.remove("ui-menu-at");
    if (s.home) {
      const { parent, next } = s.home;
      // A menu built in code and opened before it was attached had no place,
      // so it leaves the dialog rather than stay where a later open outside
      // that dialog would find it hidden inside a closed one.
      if (parent) parent.insertBefore(s.menu, next && next.parentNode === parent ? next : null);
      else s.menu.remove();
    }
    const target = /** @type {HTMLElement | null} */ (s.trigger || s.returnTo);
    // A choice that opened a dialog or moved focus itself keeps it there.
    const focusLeft = !document.activeElement || document.activeElement === document.body;
    if (returnFocus && target && target.isConnected && (hadFocus || focusLeft)) {
      target.focus({ preventScroll: true });
    }
  }

  /**
   * @param {Element} trigger
   * @param {"first" | "last"} which
   */
  function openMenu(trigger, which) {
    const menu = menuOf(trigger);
    if (!menu) return;
    closePopovers(null);
    show(menu, trigger, null, null);
    focusItem(menu, which);
  }

  /**
   * @param {HTMLElement} menu
   * @param {number} x
   * @param {number} y
   * @param {Element | null} [origin]
   */
  function openMenuAt(menu, x, y, origin) {
    closePopovers(null);
    const from = origin || document.activeElement;
    show(menu, null, from && from !== document.body ? from : null, { x, y });
    focusItem(menu, "first");
  }

  // Called for an item of the open menu, so current is set.
  /** @param {Element} item */
  function choose(item) {
    const role = item.getAttribute("role");
    if (role === "menuitemcheckbox") {
      item.setAttribute("aria-checked", String(item.getAttribute("aria-checked") !== "true"));
      return;
    }
    if (role === "menuitemradio") {
      const group = item.closest('[role="group"]') || /** @type {MenuState} */ (current).menu;
      for (const r of group.querySelectorAll('[role="menuitemradio"]')) {
        r.setAttribute("aria-checked", String(r === item));
      }
    }
    close(true);
  }

  /**
   * @param {Element} menu
   * @param {number} from
   * @param {string} key
   */
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

  // Called for a key inside the open menu, so current is set and the target
  // is an element.
  /** @param {KeyboardEvent} e */
  function menuKey(e) {
    const menu = /** @type {MenuState} */ (current).menu;
    const items = itemsOf(menu);
    const item = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest(ITEM));
    // indexOf(null) is -1, the same as an item that is not in the list.
    const i = items.indexOf(/** @type {HTMLElement} */ (item));
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
    if (item && /** @type {MenuState} */ (current).menu.contains(item)) {
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
    const t = /** @type {Node | null} */ (e.target);
    if (current.menu.contains(t) || (current.trigger && current.trigger.contains(t))) return;
    close(false);
  }, true);

  // Focus moved out by other means than a key or a click here, such as a
  // screen reader. A null relatedTarget is the window losing focus, which
  // leaves the menu as it was.
  document.addEventListener("focusout", (e) => {
    const to = /** @type {Node | null} */ (e.relatedTarget);
    if (!current || !to || current.menu.contains(to) || to === current.trigger) return;
    close(false);
  });

  // A placed menu is fixed, so it would stay put while the page under it
  // moves. An anchored one moves with its trigger, and a resize can carry it
  // across an edge or away from one.
  /** @param {Event} e */
  const dropPlaced = (e) => {
    if (!current) return;
    if (!current.placed) {
      if (e.type === "resize") nudge(current.menu);
      return;
    }
    if (e.type === "scroll" && e.target instanceof Node && current.menu.contains(e.target)) return;
    close(true);
  };
  window.addEventListener("resize", dropPlaced);
  document.addEventListener("scroll", dropPlaced, true);

  // The clear button's click runs the reset, so its reset event follows
  // within the same task; a click whose reset never comes is forgotten after.
  /** @type {Element | null} */
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
    const field = /** @type {HTMLInputElement | null} */ (form.querySelector('input[type="search"]'));
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

  // The width ui.css leaves to the host: below it a dialog is a phone's.
  const PHONE = window.matchMedia("(max-width: 600px)");
  /** @type {Record<string, string>} */
  const PHONE_CLASS = { sheet: "ui-dialog-sheet", fullscreen: "ui-dialog-fullscreen", top: "ui-dialog-top" };

  // What a dialog was opened from, and the class placeDialog added, so a
  // close can return focus and a width change can take the class away
  // without touching one the host wrote itself.
  /** @type {WeakMap<Element, Element | null>} */
  const openers = new WeakMap();
  /** @type {WeakMap<Element, string>} */
  const placedAs = new WeakMap();
  /** @type {Element | null} */
  let lastActed = null;
  /** @type {Element | null} */
  let pressedOn = null;

  /** @param {HTMLElement} dialog */
  function placeDialog(dialog) {
    const was = placedAs.get(dialog);
    const want = PHONE.matches ? PHONE_CLASS[dialog.dataset.uiPhone || ""] : undefined;
    if (was === want) return;
    if (was) dialog.classList.remove(was);
    if (want) dialog.classList.add(want);
    if (want) placedAs.set(dialog, want);
    else placedAs.delete(dialog);
  }

  /** @param {HTMLDialogElement} dialog */
  function opened(dialog) {
    const from = lastActed && !dialog.contains(lastActed) && lastActed.isConnected ? lastActed : null;
    openers.set(dialog, from);
    placeDialog(dialog);
  }

  // The element to return to is the one last focused or clicked, since Safari
  // does not focus a button on a click. Focus that showModal() moves into the
  // dialog being opened is skipped: it has no opener recorded yet.
  document.addEventListener("focusin", (e) => {
    if (!(e.target instanceof Element)) return;
    const d = e.target.closest("dialog.ui-dialog[open]");
    if (d && !openers.has(d)) return;
    lastActed = e.target;
  }, true);
  document.addEventListener("click", (e) => {
    if (e.target instanceof Element) lastActed = e.target.closest("button, a[href], summary, input, select, textarea, [tabindex]") || lastActed;
  }, true);

  new MutationObserver((records) => {
    for (const r of records) {
      const d = r.target;
      if (d instanceof HTMLDialogElement && d.classList.contains("ui-dialog") && d.open && !openers.has(d)) opened(d);
    }
  }).observe(document, { attributes: true, attributeFilter: ["open"], subtree: true });
  for (const d of document.querySelectorAll("dialog.ui-dialog[open]")) opened(/** @type {HTMLDialogElement} */ (d));

  PHONE.addEventListener("change", () => {
    for (const d of document.querySelectorAll("dialog.ui-dialog[open][data-ui-phone]")) placeDialog(/** @type {HTMLElement} */ (d));
  });

  // The close event does not bubble, so only capture sees it. Browsers that
  // restore focus have done so by now; one that left it on the page does not
  // get it moved, nor does a dialog whose choice moved focus elsewhere.
  document.addEventListener("close", (e) => {
    const d = e.target;
    if (!(d instanceof HTMLDialogElement) || !openers.has(d)) return; // only .ui-dialog is ever recorded
    const to = /** @type {HTMLElement | null} */ (openers.get(d));
    openers.delete(d);
    const at = document.activeElement;
    if (to && to.isConnected && (!at || at === document.body || d.contains(at))) to.focus({ preventScroll: true });
  }, true);

  // A click on the backdrop lands on the dialog itself, as does a drag that
  // starts in a field and ends outside the box, so the press has to start
  // there too. Padding is also the dialog itself, hence the box test.
  document.addEventListener("pointerdown", (e) => {
    pressedOn = e.target instanceof Element ? e.target : null;
  }, true);
  document.addEventListener("click", (e) => {
    const d = e.target;
    const pressed = pressedOn;
    pressedOn = null;
    if (!(d instanceof HTMLDialogElement) || pressed !== d || !d.open || !d.classList.contains("ui-dialog") || !d.hasAttribute("data-ui-backdrop")) return;
    const r = d.getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) return;
    // requestClose() is newer than showModal(); the fallback does by hand
    // what it does, so a cancel listener can still keep the dialog open.
    if (typeof d.requestClose === "function") d.requestClose();
    else if (d.dispatchEvent(new Event("cancel", { cancelable: true }))) d.close();
  }, true);

  // A collapse trigger is any button whose aria-controls names a .ui-collapse;
  // a menu trigger names a .ui-menu, so the two never overlap.
  /**
   * @param {Element} button
   * @returns {HTMLElement | null}
   */
  function collapseOf(button) {
    const id = button.getAttribute("aria-controls");
    const el = id && document.getElementById(id);
    return el && el.classList.contains("ui-collapse") ? el : null;
  }

  // The state at the click, read in capture, so an app whose own click
  // listener toggles .open already is not toggled back by the bubbling one.
  // A click the app prevents, or stops before it reaches the document, is
  // left to the app.
  /** @type {{ button: Element, panel: HTMLElement, was: boolean } | null} */
  let toggling = null;
  document.addEventListener("click", (e) => {
    toggling = null;
    const button = e.target instanceof Element && e.target.closest("button[aria-controls]");
    const panel = button && collapseOf(button);
    if (button && panel) toggling = { button, panel, was: panel.classList.contains("open") };
  }, true);
  document.addEventListener("click", (e) => {
    const t = toggling;
    toggling = null;
    if (!t || e.defaultPrevented || !t.button.isConnected) return;
    // Whether or not the app's listener toggled it, the click means the
    // opposite of what the panel was at the press.
    const open = !t.was;
    t.panel.classList.toggle("open", open);
    for (const b of document.querySelectorAll("button[aria-controls]")) {
      if (b.getAttribute("aria-controls") === t.panel.id) b.setAttribute("aria-expanded", String(open));
    }
  });

  // A popover trigger is a button whose aria-controls names a .ui-popover; a
  // menu trigger names a .ui-menu and a collapse trigger a .ui-collapse.
  // Unlike the menu, a popover holds form fields, so it takes no arrow keys,
  // Home, End or type-ahead, and Tab moves on inside and out of it.
  // Popups a control inside the popover opens, such as a themed select's
  // list, are mounted elsewhere in the page.
  const POPUP = '[role="listbox"], [role="menu"], [role="tree"], [role="grid"]';

  /**
   * @param {Element} pop
   * @returns {HTMLButtonElement[]}
   */
  function triggersOf(pop) {
    if (!pop.id) return [];
    return [.../** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll(`button[aria-controls="${CSS.escape(pop.id)}"]`))];
  }

  /**
   * @param {Element} button
   * @returns {HTMLElement | null}
   */
  function popoverOf(button) {
    const id = button.getAttribute("aria-controls");
    const el = id && document.getElementById(id);
    return el && el.classList.contains("ui-popover") ? el : null;
  }

  // Only a popover with a trigger is ours: a bare one is the app's.
  /** @returns {HTMLElement[]} */
  const openPopovers = () => [.../** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(".ui-popover:not([hidden])"))]
    .filter((p) => triggersOf(p).length > 0);

  /** @type {WeakMap<Element, Element>} */
  const popoverOpener = new WeakMap();

  /**
   * @param {HTMLElement} pop
   * @param {boolean} open
   */
  function setPopover(pop, open) {
    pop.hidden = !open;
    for (const b of triggersOf(pop)) b.setAttribute("aria-expanded", String(open));
  }

  // Opening one overlay closes the others, as a menu does.
  /** @param {Element | null} except */
  function closePopovers(except) {
    for (const p of openPopovers()) if (p !== except) setPopover(p, false);
  }

  // Whether a press at target is in a popup that a control of the popover
  // has opened: one named by aria-controls or aria-owns, or any listbox,
  // menu, tree or grid while one of its controls is aria-expanded.
  /**
   * @param {HTMLElement} pop
   * @param {Element} target
   */
  function ownsPopup(pop, target) {
    const popup = target.closest(POPUP);
    if (!popup) return false;
    return [...pop.querySelectorAll('[aria-expanded="true"], [aria-controls], [aria-owns]')].some((c) =>
      c.getAttribute("aria-expanded") === "true"
      || (popup.id !== "" && (c.getAttribute("aria-controls") === popup.id || c.getAttribute("aria-owns") === popup.id)));
  }

  // Read in capture, as the collapse does, so an app whose own click listener
  // toggles hidden is not toggled back, and a click it stops or prevents is
  // left to it.
  /** @type {{ button: Element, pop: HTMLElement, was: boolean } | null} */
  let popToggling = null;
  document.addEventListener("click", (e) => {
    popToggling = null;
    const button = e.target instanceof Element && e.target.closest("button[aria-controls]");
    const pop = button && popoverOf(button);
    if (button && pop) popToggling = { button, pop, was: !pop.hidden };
  }, true);
  document.addEventListener("click", (e) => {
    const t = popToggling;
    popToggling = null;
    if (!t || e.defaultPrevented || !t.button.isConnected) return;
    const open = !t.was;
    if (open) {
      close(false);
      closePopovers(t.pop);
      popoverOpener.set(t.pop, t.button);
    }
    setPopover(t.pop, open);
  });

  // A press outside closes the popover and leaves focus to where the press
  // lands, unless it was inside the popover, which then returns it to the
  // trigger.
  document.addEventListener("pointerdown", (e) => {
    const target = e.target instanceof Element ? e.target : null;
    for (const pop of openPopovers()) {
      if (target && (pop.contains(target) || triggersOf(pop).some((b) => b.contains(target)) || ownsPopup(pop, target))) continue;
      const hadFocus = pop.contains(document.activeElement);
      setPopover(pop, false);
      const to = popoverOpener.get(pop) || triggersOf(pop)[0];
      if (hadFocus && to instanceof HTMLElement && to.isConnected) to.focus({ preventScroll: true });
    }
  }, true);

  // Bubble phase, so a control inside the popover that takes Escape first,
  // such as an open themed select, ends the event before this sees it, and
  // so does one that only prevents it. On the document, since a button tapped
  // in Safari takes no focus and the key then goes to the body. Preventing
  // the default keeps an open modal dialog from closing with the popover.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    const open = openPopovers();
    if (!open.length) return;
    e.preventDefault();
    const first = open[0];
    for (const pop of open) setPopover(pop, false);
    const to = popoverOpener.get(first) || triggersOf(first)[0];
    if (to instanceof HTMLElement && to.isConnected) to.focus({ preventScroll: true });
  });

  // A tab belongs to the nearest tablist, so a tablist inside a panel of
  // another keeps its own tabs.
  /**
   * @param {Element} tablist
   * @returns {HTMLElement[]}
   */
  function tabsOf(tablist) {
    return [...tablist.querySelectorAll('[role="tab"]')].filter(
      (t) => t.closest('[role="tablist"]') === tablist,
    ).map((t) => /** @type {HTMLElement} */ (t));
  }

  /** @param {HTMLElement} tab */
  function selectTab(tab) {
    const tablist = tab.closest('[role="tablist"]');
    if (!tablist) return;
    for (const t of tabsOf(tablist)) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      const id = t.getAttribute("aria-controls");
      const panel = id && document.getElementById(id);
      if (panel) panel.hidden = !on;
    }
  }

  /** @param {EventTarget | null} target */
  function tabFrom(target) {
    const tab = target instanceof Element && target.closest('[role="tab"]');
    return tab && tab.closest('[role="tablist"]') ? /** @type {HTMLElement} */ (tab) : null;
  }

  /** @param {Element} el */
  const tabEnabled = (el) => !(/** @type {HTMLButtonElement} */ (el).disabled) && el.getAttribute("aria-disabled") !== "true";

  document.addEventListener("click", (e) => {
    const tab = tabFrom(e.target);
    if (tab && !e.defaultPrevented && tabEnabled(tab)) selectTab(tab);
  });

  document.addEventListener("keydown", (e) => {
    const tab = tabFrom(e.target);
    if (!tab || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    const tablist = /** @type {Element} */ (tab.closest('[role="tablist"]'));
    const vertical = tablist.getAttribute("aria-orientation") === "vertical";
    const rtl = getComputedStyle(tablist).direction === "rtl";
    const step = vertical
      ? { ArrowDown: 1, ArrowUp: -1 }[e.key]
      : { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }[e.key];
    const all = tabsOf(tablist).filter(tabEnabled);
    if (!all.length) return;
    let next;
    if (step) {
      const at = all.indexOf(tab);
      // A disabled tab holding focus is not in the list: start from the end the key points at.
      next = at < 0 ? (step > 0 ? all[0] : all[all.length - 1]) : all[(at + step + all.length) % all.length];
    } else if (e.key === "Home") next = all[0];
    else if (e.key === "End") next = all[all.length - 1];
    if (!next) return;
    e.preventDefault();
    if (next === tab) return;
    next.focus();
    next.click();
  });

  // One toast element serves every call, so there is one live region and one
  // toast at a time. The first call adds it hidden and empty and fills it a
  // moment later, since text already in a region when it arrives is often not
  // announced.
  const TOAST_MS = 4500;
  const TOAST_ANNOUNCE_MS = 100;
  /** @type {HTMLElement | null} */
  let toastEl = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let toastTimer = null;
  let toastSeq = 0;

  function dismissToast() {
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = null;
    toastSeq++;
    if (!toastEl) return;
    toastEl.hidden = true;
    toastEl.replaceChildren();
  }

  /**
   * @param {string} text
   * @param {{ action?: { label: string, onClick?: () => void }, timeout?: number }} [options]
   */
  function toast(text, options) {
    const { action, timeout = TOAST_MS } = options || {};
    const fresh = !toastEl;
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "ui-toast";
      toastEl.setAttribute("role", "status");
      toastEl.hidden = true;
      document.body.append(toastEl);
    }
    const el = toastEl;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = null;
    const seq = ++toastSeq;
    const show = () => {
      if (seq !== toastSeq) return;
      const span = document.createElement("span");
      span.textContent = text;
      el.replaceChildren(span);
      if (action) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ui-button ui-button-quiet";
        button.textContent = action.label;
        button.addEventListener("click", () => {
          try {
            if (action.onClick) action.onClick();
          } finally {
            if (seq === toastSeq) dismissToast();
          }
        });
        el.append(button);
      }
      el.hidden = false;
      if (!action && timeout > 0) toastTimer = setTimeout(dismissToast, timeout);
    };
    if (fresh) setTimeout(show, TOAST_ANNOUNCE_MS);
    else show();
  }

  /**
   * @param {{ title: string, body?: string, confirmLabel?: string, cancelLabel?: string, danger?: boolean }} options
   * @returns {Promise<boolean>}
   */
  function confirm({ title, body, confirmLabel, cancelLabel, danger }) {
    const dialog = document.createElement("dialog");
    dialog.className = "ui-dialog";
    dialog.dataset.uiBackdrop = "";
    dialog.dataset.uiPhone = "sheet";
    const handle = document.createElement("div");
    handle.className = "ui-dialog-handle";
    handle.setAttribute("aria-hidden", "true");
    const head = document.createElement("div");
    head.className = "ui-dialog-head";
    const heading = document.createElement("h2");
    heading.className = "ui-dialog-title";
    heading.id = `ui-confirm-${++confirms}`;
    heading.textContent = title;
    head.append(heading);
    dialog.setAttribute("aria-labelledby", heading.id);
    const content = document.createElement("div");
    content.className = "ui-dialog-body";
    if (body) {
      const text = document.createElement("p");
      text.textContent = body;
      content.append(text);
    }
    const actions = document.createElement("div");
    actions.className = "ui-dialog-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "ui-button";
    cancel.textContent = cancelLabel || "Cancel";
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = `ui-button ${danger ? "ui-button-danger" : "ui-button-primary"}`;
    ok.textContent = confirmLabel || "Confirm";
    actions.append(cancel, ok);
    dialog.append(handle, head, content, actions);

    return new Promise((resolve) => {
      cancel.addEventListener("click", () => dialog.close("cancel"));
      ok.addEventListener("click", () => dialog.close("confirm"));
      // Enter on a button is that button's click, so only a press elsewhere,
      // in the text, is read as the confirm.
      dialog.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" || e.defaultPrevented || e.target instanceof HTMLButtonElement) return;
        e.preventDefault();
        dialog.close("confirm");
      });
      dialog.addEventListener("close", () => {
        resolve(dialog.returnValue === "confirm");
        dialog.remove();
      });
      document.body.append(dialog);
      dialog.showModal();
      ok.focus();
    });
  }

  let confirms = 0;

  window.uiFoundation = Object.freeze({
    confirm,
    openMenu: (trigger) => openMenu(trigger, "first"),
    openMenuAt,
    closeMenu: () => close(true),
    toast,
  });
})();

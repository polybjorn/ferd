import { setActiveTab, setCrumb, state } from './core.js';
import { hasServer } from './server.js';
import { catalogCache, places } from './store.js';
import { historyEnabled } from './prefs.js';
import { cleanupMap } from './map/index.js';
import { HistoryPage } from './history.js';
import { catalogUpdatesPending, openAboutModal, openAccountSheet } from './auth.js';
import { openSignInModal } from './sign-in.js';
import { html, mountPage } from './view.js';

// The phone's You page: who is signed in, a gear for what the wide screen's
// menu holds, and History below. A visitor to a public map gets Sign in.
export function renderYouPage() {
  const signedIn = !!(state.auth && state.auth.authenticated);
  setActiveTab(signedIn && historyEnabled() ? 'history' : 'you');
  setCrumb('You');
  cleanupMap();
  mountPage(html`<${YouPage} />`);
}

const ICON = /** @param {string} paths */ paths => html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" dangerouslySetInnerHTML=${{ __html: paths }}></svg>`;
const GEAR = '<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/>';
const USER = '<path d="M18 20a6 6 0 0 0-12 0"/><circle cx="12" cy="10" r="4"/><circle cx="12" cy="12" r="10"/>';

function YouPage() {
  // Read for the subscription: the gear's dot follows pending catalog updates.
  places.value; catalogCache.value;
  if (!(state.auth && state.auth.authenticated)) {
    return html`<div class="you-signin">
        ${ICON(USER)}
        <p>Viewing a shared map</p>
        <button type="button" class="ui-button ui-button-primary" id="you-signin" onClick=${() => openSignInModal()}>Sign in</button>
      </div>
      <div class="you-rows"><button type="button" id="you-about" onClick=${() => openAboutModal()}>About</button></div>`;
  }
  const local = !hasServer();
  return html`<div class="you-head">
      <div class="you-name">
        <span>${local ? 'Local map' : 'Signed in as'}</span>
        <strong>${local ? 'No account' : state.auth.username}</strong>
      </div>
      <button type="button" class=${'you-gear' + (catalogUpdatesPending() ? ' has-dot' : '')} id="you-gear"
        title="Settings and account" aria-label="Settings and account" onClick=${() => openAccountSheet()}>${ICON(GEAR)}</button>
    </div>
    ${historyEnabled() && html`<${HistoryPage} />`}`;
}

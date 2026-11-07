import { localLogClear } from './device-cache.js';
import { isLocalMode } from './local-mode.js';
import { api } from './auth.js';
import { renderAdminLogs } from './settings-account.js';
import { modalHeaderHtml, openConfirmModal } from './select.js';
import { openFullScreenModal } from './modal.js';

export function openLogsModal() {
  const local = isLocalMode();
  const title = local ? 'Activity log' : 'Audit log';
  openFullScreenModal(
    modalHeaderHtml(title) +
    '<div id="s-admin-logs"><div class="hint">Loading&hellip;</div></div>' +
    '<div class="ui-dialog-actions"><button type="button" id="s-logs-clear" class="ui-button ui-button-danger">Clear all</button></div>',
    function() {
      renderAdminLogs();
      const clearBtn = /** @type {HTMLButtonElement} */ (document.getElementById('s-logs-clear'));
      if (clearBtn) {
        clearBtn.addEventListener('click', function() {
          openConfirmModal({
            title: 'Clear ' + title.toLowerCase(),
            body: 'This permanently deletes all logged events. Continue?',
            confirmLabel: 'Clear all',
            danger: true,
          }).then(ok => {
            if (!ok) return;
            clearBtn.disabled = true;
            (local ? localLogClear() : api('DELETE', '/admin/logs'))
              .then(() => renderAdminLogs())
              .catch(err => alert('Failed: ' + err.message))
              .then(() => { clearBtn.disabled = false; });
          });
        });
      }
    }
  );
}

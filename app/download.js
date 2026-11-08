import { t } from './i18n.js';

// Hands a downloaded file to the user. The Android shell's WebView drops
// blob and anchor downloads, so there the bytes go to native, which opens the
// system "Save to..." picker.
/**
 * @param {Blob} blob
 * @param {string} fname
 * @param {string} mimeType
 */
export async function saveDownload(blob, fname, mimeType) {
  const android = window.FerdAndroid;
  if (android && typeof android.exportFile === 'function') {
    const exportFile = android.exportFile.bind(android);
    await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(t('backup.exportRead')));
      reader.onloadend = () => {
        const b64 = String(reader.result).split(',')[1] || '';
        exportFile(fname, blob.type || mimeType, b64);
        resolve(undefined);
      };
      reader.readAsDataURL(blob);
    });
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fname;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

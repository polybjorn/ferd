// Shows the update notice on a browser without cascade layers (before Chrome
// 99). Kept a classic script in plain ES5 so that browser still runs it.
if (!('CSSLayerBlockRule' in window)) document.getElementById('webview-notice').hidden = false;

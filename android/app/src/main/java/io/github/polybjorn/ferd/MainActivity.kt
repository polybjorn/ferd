package io.github.polybjorn.ferd

import android.Manifest
import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.util.Base64
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.Toast
import android.net.http.SslError
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.webkit.ServiceWorkerClientCompat
import androidx.webkit.ServiceWorkerControllerCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import androidx.webkit.WebViewFeature

/**
 * Single-Activity WebView shell. The Ferd frontend is bundled in the APK and
 * served from a secure in-app origin (https://appassets.androidplatform.net/)
 * via [WebViewAssetLoader]. That origin is cross-origin to whichever server the
 * user picks, so the frontend's own server-picker + bearer-token path drives
 * the connection; nothing about the server is baked into the app.
 */
class MainActivity : AppCompatActivity() {

  private lateinit var webView: WebView
  private lateinit var certStore: CertStore

  // Pending callbacks bridged between WebView prompts and Android result APIs.
  private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
  private var pendingGeolocationOrigin: String? = null
  private var pendingGeolocationCallback: GeolocationPermissions.Callback? = null

  private lateinit var fileChooserLauncher: ActivityResultLauncher<Intent>
  private lateinit var locationPermissionLauncher: ActivityResultLauncher<String>
  private lateinit var createDocumentLauncher: ActivityResultLauncher<String>

  // Bytes awaiting a destination chosen via the system "Save to..." dialog.
  private var pendingExportBytes: ByteArray? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    certStore = CertStore(this)

    fileChooserLauncher = registerForActivityResult(
      ActivityResultContracts.StartActivityForResult()
    ) { result ->
      val cb = fileChooserCallback
      fileChooserCallback = null
      if (cb == null) return@registerForActivityResult
      val uris = WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
      cb.onReceiveValue(uris ?: emptyArray())
    }

    locationPermissionLauncher = registerForActivityResult(
      ActivityResultContracts.RequestPermission()
    ) { granted ->
      val origin = pendingGeolocationOrigin
      val cb = pendingGeolocationCallback
      pendingGeolocationOrigin = null
      pendingGeolocationCallback = null
      if (origin != null && cb != null) cb.invoke(origin, granted, false)
    }

    createDocumentLauncher = registerForActivityResult(
      ActivityResultContracts.CreateDocument("application/zip")
    ) { uri ->
      val bytes = pendingExportBytes
      pendingExportBytes = null
      if (uri == null || bytes == null) return@registerForActivityResult
      // Write off the UI thread; an export can be a few MB.
      Thread {
        val ok = try {
          contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
          true
        } catch (e: Exception) {
          false
        }
        runOnUiThread {
          Toast.makeText(
            this,
            if (ok) R.string.export_saved else R.string.export_failed,
            Toast.LENGTH_SHORT,
          ).show()
        }
      }.start()
    }

    webView = WebView(this)
    setContentView(webView)
    configureWebView()
    webView.addJavascriptInterface(FerdBridge(this), "FerdAndroid")

    if (savedInstanceState == null) {
      webView.loadUrl("https://" + WebViewAssetLoader.DEFAULT_DOMAIN + "/index.html")
    } else {
      webView.restoreState(savedInstanceState)
    }

    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        if (webView.canGoBack()) webView.goBack() else finish()
      }
    })
  }

  private fun configureWebView() {
    val assetLoader = WebViewAssetLoader.Builder()
      .addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(this))
      .build()

    with(webView.settings) {
      javaScriptEnabled = true
      domStorageEnabled = true          // localStorage holds the server + token
      databaseEnabled = true
      setGeolocationEnabled(true)
      setSupportZoom(false)
      builtInZoomControls = false
      mediaPlaybackRequiresUserGesture = false
      // Plain-http servers are allowed (the picker warns about it), and the app
      // origin is https, so http API calls would otherwise be blocked as mixed
      // content. The user opted into the risk per-server.
      mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
    }

    // Service worker fetches for app-origin shell assets must resolve through
    // the same asset loader, or the registered SW would fail to serve them.
    if (WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_BASIC_USAGE)) {
      ServiceWorkerControllerCompat.getInstance().setServiceWorkerClient(
        object : ServiceWorkerClientCompat() {
          override fun shouldInterceptRequest(request: WebResourceRequest): WebResourceResponse? =
            assetLoader.shouldInterceptRequest(request.url)
        }
      )
    }

    webView.webViewClient = object : WebViewClientCompat() {
      override fun shouldInterceptRequest(
        view: WebView,
        request: WebResourceRequest,
      ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)

      override fun shouldOverrideUrlLoading(
        view: WebView,
        request: WebResourceRequest,
      ): Boolean {
        val url = request.url
        // Keep app-origin navigations in the WebView; send anything else (a
        // place's external "source" link, etc.) to the system browser.
        if (url.host == WebViewAssetLoader.DEFAULT_DOMAIN) return false
        return try {
          startActivity(Intent(Intent.ACTION_VIEW, url))
          true
        } catch (e: Exception) {
          false
        }
      }

      override fun onReceivedSslError(
        view: WebView,
        handler: SslErrorHandler,
        error: SslError,
      ) {
        val host = Uri.parse(error.url).host ?: run { handler.cancel(); return }
        val fp = CertStore.fingerprint(error.certificate)
        if (fp != null && certStore.isTrusted(host, fp)) {
          handler.proceed()
          return
        }
        promptUntrustedCert(host, fp, handler)
      }
    }

    webView.webChromeClient = object : WebChromeClient() {
      override fun onGeolocationPermissionsShowPrompt(
        origin: String,
        callback: GeolocationPermissions.Callback,
      ) {
        if (hasLocationPermission()) {
          callback.invoke(origin, true, false)
        } else {
          pendingGeolocationOrigin = origin
          pendingGeolocationCallback = callback
          locationPermissionLauncher.launch(Manifest.permission.ACCESS_FINE_LOCATION)
        }
      }

      override fun onShowFileChooser(
        webView: WebView,
        filePathCallback: ValueCallback<Array<Uri>>,
        fileChooserParams: FileChooserParams,
      ): Boolean {
        fileChooserCallback?.onReceiveValue(null)
        fileChooserCallback = filePathCallback
        return try {
          fileChooserLauncher.launch(fileChooserParams.createIntent())
          true
        } catch (e: Exception) {
          fileChooserCallback = null
          false
        }
      }
    }

    webView.setDownloadListener { url, _, _, _, _ ->
      val uri = Uri.parse(url)
      val scheme = uri.scheme?.lowercase()
      if (scheme == "http" || scheme == "https") {
        val request = DownloadManager.Request(uri)
          .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
          .setDestinationInExternalPublicDir(
            android.os.Environment.DIRECTORY_DOWNLOADS,
            uri.lastPathSegment ?: "ferd-download"
          )
        (getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(request)
      } else {
        // blob:/data: downloads (e.g. the export zip) aren't handled yet.
        Toast.makeText(this, R.string.download_unsupported, Toast.LENGTH_LONG).show()
      }
    }
  }

  private fun promptUntrustedCert(host: String, fingerprint: String?, handler: SslErrorHandler) {
    val fpText = fingerprint?.chunked(2)?.joinToString(":") ?: "unknown"
    AlertDialog.Builder(this)
      .setTitle(getString(R.string.cert_title, host))
      .setMessage(getString(R.string.cert_message, fpText))
      .setPositiveButton(R.string.cert_trust) { _, _ ->
        if (fingerprint != null) certStore.trust(host, fingerprint)
        handler.proceed()
      }
      .setNegativeButton(R.string.cert_cancel) { _, _ -> handler.cancel() }
      .setOnCancelListener { handler.cancel() }
      .show()
  }

  /** Decode the base64 export and open the system "Save to..." dialog. */
  fun beginExport(filename: String, base64Data: String) {
    pendingExportBytes = try {
      Base64.decode(base64Data, Base64.DEFAULT)
    } catch (e: IllegalArgumentException) {
      null
    }
    if (pendingExportBytes == null) {
      Toast.makeText(this, R.string.export_failed, Toast.LENGTH_LONG).show()
      return
    }
    createDocumentLauncher.launch(filename.ifBlank { "ferd-export.zip" })
  }

  private fun hasLocationPermission(): Boolean =
    ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) ==
      PackageManager.PERMISSION_GRANTED

  override fun onSaveInstanceState(outState: Bundle) {
    super.onSaveInstanceState(outState)
    webView.saveState(outState)
  }
}

/**
 * JS bridge exposed to the bundled frontend as `window.FerdAndroid`. WebView
 * silently drops blob downloads, so the export flow hands the file here and
 * native saves it via the system document picker. Only the bundled frontend
 * runs in this WebView (external links open in the system browser), so the
 * surface stays trusted.
 */
private class FerdBridge(private val activity: MainActivity) {
  @JavascriptInterface
  fun exportFile(filename: String, mimeType: String, base64Data: String) {
    activity.runOnUiThread { activity.beginExport(filename, base64Data) }
  }

  /** Build version (e.g. "0.1.0+18.gb822621"), shown in the app's About box. */
  @JavascriptInterface
  fun appVersion(): String = BuildConfig.VERSION_NAME
}


package io.github.polybjorn.ferd

import android.content.Context
import android.net.Uri
import android.util.Base64
import android.webkit.WebResourceResponse
import java.security.MessageDigest

/**
 * The shell's Content-Security-Policy. The WebView loads the page from the
 * asset loader, so no server header ever reaches it; this puts the same policy
 * on the intercepted responses for the document and the service worker.
 *
 * POLICY mirrors DEFAULT_POLICY in tools/ferd_api/csp.py (tests/test_csp.py
 * holds the two together) with two differences: connect-src also allows
 * http:, since the server picker accepts plain-http servers, and there is no
 * report-uri, since the asset origin has no endpoint to take reports.
 */
object ContentSecurityPolicy {
  // Report-Only until the enforcing switch lands, the same default as the
  // server's FERD_CSP_MODE.
  private const val HEADER = "Content-Security-Policy-Report-Only"

  private const val POLICY =
    "default-src 'self'; " +
      "script-src 'self' {importmap}; " +
      "style-src 'self'; " +
      "img-src 'self' data: blob: https:; " +
      "connect-src 'self' https: http:; " +
      "worker-src 'self'; " +
      "manifest-src 'self'; " +
      "object-src 'none'; " +
      "base-uri 'none'; " +
      "form-action 'self'; " +
      "frame-ancestors 'none'"

  private val IMPORTMAP = Regex("<script type=\"importmap\">(.*?)</script>", RegexOption.DOT_MATCHES_ALL)

  @Volatile private var value: String? = null

  private fun policy(context: Context): String {
    value?.let { return it }
    val html = context.assets.open("index.html").use { it.readBytes().toString(Charsets.UTF_8) }
    val map = IMPORTMAP.find(html)?.groupValues?.get(1)
    val hash = if (map == null) "" else {
      val digest = MessageDigest.getInstance("SHA-256").digest(map.toByteArray(Charsets.UTF_8))
      "'sha256-" + Base64.encodeToString(digest, Base64.NO_WRAP) + "'"
    }
    return POLICY.replace("{importmap}", hash).also { value = it }
  }

  /** `response` with the policy added when `url` is the document or sw.js. */
  fun apply(context: Context, url: Uri, response: WebResourceResponse?): WebResourceResponse? {
    if (response == null) return null
    when (url.path) {
      "/", "/index.html", "/sw.js" -> {}
      else -> return response
    }
    val headers = HashMap(response.responseHeaders ?: emptyMap())
    headers[HEADER] = policy(context)
    headers["X-Content-Type-Options"] = "nosniff"
    response.responseHeaders = headers
    return response
  }
}

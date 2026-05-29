package io.github.polybjorn.ferd

import android.content.Context
import android.net.http.SslCertificate
import android.os.Build
import java.io.ByteArrayInputStream
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate

/**
 * Trust-on-first-use store for self-signed / otherwise untrusted server certs.
 * The user explicitly accepts a cert once; its SHA-256 fingerprint is pinned
 * per host, so a later silent change re-triggers the warning instead of being
 * accepted blindly. Backed by SharedPreferences.
 */
class CertStore(context: Context) {

  private val prefs = context.getSharedPreferences("trusted_certs", Context.MODE_PRIVATE)

  fun isTrusted(host: String, fingerprint: String): Boolean =
    prefs.getStringSet(host, emptySet())?.contains(fingerprint) == true

  fun trust(host: String, fingerprint: String) {
    val current = prefs.getStringSet(host, emptySet()) ?: emptySet()
    prefs.edit().putStringSet(host, current + fingerprint).apply()
  }

  companion object {
    /** Lowercase hex SHA-256 of the certificate's DER encoding, or null. */
    fun fingerprint(cert: SslCertificate?): String? {
      val x509 = cert?.let { toX509(it) } ?: return null
      return try {
        MessageDigest.getInstance("SHA-256")
          .digest(x509.encoded)
          .joinToString("") { "%02x".format(it) }
      } catch (e: Exception) {
        null
      }
    }

    private fun toX509(cert: SslCertificate): X509Certificate? {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        cert.x509Certificate?.let { return it }
      }
      // Pre-Q: recover the DER from the saved-state bundle.
      return try {
        val der = SslCertificate.saveState(cert).getByteArray("x509-certificate") ?: return null
        CertificateFactory.getInstance("X.509")
          .generateCertificate(ByteArrayInputStream(der)) as? X509Certificate
      } catch (e: Exception) {
        null
      }
    }
  }
}

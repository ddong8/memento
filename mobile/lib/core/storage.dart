import 'package:shared_preferences/shared_preferences.dart';

/// Storage helper to persist tokens and server connection configuration
class AppStorage {
  static const String _keyServerUrl = 'server_url';
  static const String _keyToken = 'auth_token';
  static const String _keyUsername = 'auth_username';
  static const String _keyLastDeviceId = 'last_device_id';

  static const String defaultServerUrl = 'https://mem.ihasy.com';

  static SharedPreferences? _prefs;
  static String? _cachedServerUrl;
  static String? _cachedToken;
  static String? _cachedUsername;
  static String? _cachedLastDeviceId;

  static Future<SharedPreferences> _getPrefs() async {
    return _prefs ??= await SharedPreferences.getInstance();
  }

  static Future<String> getServerUrl() async {
    if (_cachedServerUrl != null) return _cachedServerUrl!;
    final prefs = await _getPrefs();
    _cachedServerUrl = prefs.getString(_keyServerUrl) ?? defaultServerUrl;
    return _cachedServerUrl!;
  }

  static Future<void> setServerUrl(String url) async {
    var cleanUrl = url.trim();
    if (cleanUrl.endsWith('/')) {
      cleanUrl = cleanUrl.substring(0, cleanUrl.length - 1);
    }
    _cachedServerUrl = cleanUrl;
    final prefs = await _getPrefs();
    await prefs.setString(_keyServerUrl, cleanUrl);
  }

  static Future<String?> getToken() async {
    if (_cachedToken != null) return _cachedToken;
    final prefs = await _getPrefs();
    _cachedToken = prefs.getString(_keyToken);
    return _cachedToken;
  }

  static Future<void> setToken(String? token) async {
    _cachedToken = token;
    final prefs = await _getPrefs();
    if (token == null || token.isEmpty) {
      await prefs.remove(_keyToken);
    } else {
      await prefs.setString(_keyToken, token);
    }
  }

  static Future<String?> getUsername() async {
    if (_cachedUsername != null) return _cachedUsername;
    final prefs = await _getPrefs();
    _cachedUsername = prefs.getString(_keyUsername);
    return _cachedUsername;
  }

  static Future<void> setUsername(String? username) async {
    _cachedUsername = username;
    final prefs = await _getPrefs();
    if (username == null) {
      await prefs.remove(_keyUsername);
    } else {
      await prefs.setString(_keyUsername, username);
    }
  }

  static Future<String?> getLastDeviceId() async {
    if (_cachedLastDeviceId != null) return _cachedLastDeviceId;
    final prefs = await _getPrefs();
    _cachedLastDeviceId = prefs.getString(_keyLastDeviceId);
    return _cachedLastDeviceId;
  }

  static Future<void> setLastDeviceId(String? deviceId) async {
    _cachedLastDeviceId = deviceId;
    final prefs = await _getPrefs();
    if (deviceId == null) {
      await prefs.remove(_keyLastDeviceId);
    } else {
      await prefs.setString(_keyLastDeviceId, deviceId);
    }
  }

  static Future<void> clearSession() async {
    _cachedToken = null;
    _cachedUsername = null;
    final prefs = await _getPrefs();
    await prefs.remove(_keyToken);
    await prefs.remove(_keyUsername);
  }
}

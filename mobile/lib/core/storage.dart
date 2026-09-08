import 'package:shared_preferences/shared_preferences.dart';

/// Storage helper to persist tokens and server connection configuration
class AppStorage {
  static const String _keyServerUrl = 'server_url';
  static const String _keyToken = 'auth_token';
  static const String _keyUsername = 'auth_username';
  static const String _keyLastDeviceId = 'last_device_id';

  static const String defaultServerUrl = 'https://mem.ihasy.com';

  static Future<String> getServerUrl() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_keyServerUrl) ?? defaultServerUrl;
  }

  static Future<void> setServerUrl(String url) async {
    final prefs = await SharedPreferences.getInstance();
    var cleanUrl = url.trim();
    if (cleanUrl.endsWith('/')) {
      cleanUrl = cleanUrl.substring(0, cleanUrl.length - 1);
    }
    await prefs.setString(_keyServerUrl, cleanUrl);
  }

  static Future<String?> getToken() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_keyToken);
  }

  static Future<void> setToken(String? token) async {
    final prefs = await SharedPreferences.getInstance();
    if (token == null || token.isEmpty) {
      await prefs.remove(_keyToken);
    } else {
      await prefs.setString(_keyToken, token);
    }
  }

  static Future<String?> getUsername() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_keyUsername);
  }

  static Future<void> setUsername(String? username) async {
    final prefs = await SharedPreferences.getInstance();
    if (username == null) {
      await prefs.remove(_keyUsername);
    } else {
      await prefs.setString(_keyUsername, username);
    }
  }

  static Future<String?> getLastDeviceId() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_keyLastDeviceId);
  }

  static Future<void> setLastDeviceId(String? deviceId) async {
    final prefs = await SharedPreferences.getInstance();
    if (deviceId == null) {
      await prefs.remove(_keyLastDeviceId);
    } else {
      await prefs.setString(_keyLastDeviceId, deviceId);
    }
  }

  static Future<void> clearSession() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_keyToken);
    await prefs.remove(_keyUsername);
  }
}

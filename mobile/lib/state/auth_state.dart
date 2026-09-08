import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../core/api_client.dart';
import '../core/storage.dart';

class AuthState {
  final bool isLoading;
  final bool isAuthenticated;
  final String? username;
  final String serverUrl;
  final String? errorMessage;

  AuthState({
    this.isLoading = false,
    this.isAuthenticated = false,
    this.username,
    required this.serverUrl,
    this.errorMessage,
  });

  AuthState copyWith({
    bool? isLoading,
    bool? isAuthenticated,
    String? username,
    String? serverUrl,
    String? errorMessage,
  }) {
    return AuthState(
      isLoading: isLoading ?? this.isLoading,
      isAuthenticated: isAuthenticated ?? this.isAuthenticated,
      username: username ?? this.username,
      serverUrl: serverUrl ?? this.serverUrl,
      errorMessage: errorMessage,
    );
  }
}

class AuthNotifier extends StateNotifier<AuthState> {
  AuthNotifier()
      : super(AuthState(serverUrl: AppStorage.defaultServerUrl)) {
    checkInitialAuth();
  }

  Future<void> checkInitialAuth() async {
    state = state.copyWith(isLoading: true);
    final serverUrl = await AppStorage.getServerUrl();
    final token = await AppStorage.getToken();
    final username = await AppStorage.getUsername();

    if (token != null && token.isNotEmpty) {
      try {
        await ApiClient().getMe();
        state = state.copyWith(
          isLoading: false,
          isAuthenticated: true,
          username: username,
          serverUrl: serverUrl,
        );
        return;
      } catch (_) {
        // Token invalid
        await AppStorage.clearSession();
      }
    }

    state = state.copyWith(
      isLoading: false,
      isAuthenticated: false,
      serverUrl: serverUrl,
    );
  }

  Future<bool> login(String username, String password) async {
    state = state.copyWith(isLoading: true, errorMessage: null);
    try {
      await ApiClient().login(username, password);
      state = state.copyWith(
        isLoading: false,
        isAuthenticated: true,
        username: username,
      );
      return true;
    } catch (e) {
      state = state.copyWith(
        isLoading: false,
        errorMessage: '登录失败: 请检查账号密码或服务器连接',
      );
      return false;
    }
  }

  Future<void> updateServerUrl(String newUrl) async {
    await AppStorage.setServerUrl(newUrl);
    final savedUrl = await AppStorage.getServerUrl();
    state = state.copyWith(serverUrl: savedUrl);
  }

  Future<void> logout() async {
    await AppStorage.clearSession();
    state = state.copyWith(
      isAuthenticated: false,
      username: null,
    );
  }
}

final authProvider = StateNotifierProvider<AuthNotifier, AuthState>((ref) {
  return AuthNotifier();
});

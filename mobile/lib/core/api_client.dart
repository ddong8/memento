import 'package:dio/dio.dart';
import '../models/ask_conversation.dart';
import 'storage.dart';

class ApiClient {
  static final ApiClient _instance = ApiClient._internal();
  factory ApiClient() => _instance;

  late Dio _dio;

  ApiClient._internal() {
    _dio = Dio(
      BaseOptions(
        connectTimeout: const Duration(seconds: 20),
        receiveTimeout: const Duration(seconds: 45),
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
      ),
    );

    _dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) async {
          // Dynamic base URL from storage
          final serverUrl = await AppStorage.getServerUrl();
          options.baseUrl = serverUrl;

          // Inject token if available
          final token = await AppStorage.getToken();
          if (token != null && token.isNotEmpty) {
            options.headers['Authorization'] = 'Bearer $token';
          }
          return handler.next(options);
        },
        onError: (DioException e, handler) async {
          if (e.response?.statusCode == 401) {
            // Token expired or invalid
            await AppStorage.clearSession();
          }
          return handler.next(e);
        },
      ),
    );
  }

  Dio get dio => _dio;

  // --- Auth Endpoints ---

  Future<Map<String, dynamic>> login(String usernameOrEmail, String password) async {
    final response = await _dio.post(
      '/api/auth/login',
      data: {
        'email': usernameOrEmail,
        'password': password,
      },
    );
    final data = response.data as Map<String, dynamic>;
    final token = data['access_token'] ?? data['token'];
    if (token != null) {
      await AppStorage.setToken(token.toString());
      await AppStorage.setUsername(usernameOrEmail);
    }
    return data;
  }

  Future<Map<String, dynamic>> register(String email, String password) async {
    final response = await _dio.post(
      '/api/auth/register',
      data: {
        'email': email,
        'password': password,
      },
    );
    return response.data as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> getMe() async {
    final response = await _dio.get('/api/auth/me');
    return response.data as Map<String, dynamic>;
  }

  // --- Devices ---

  Future<List<Map<String, dynamic>>> getDevices() async {
    final response = await _dio.get('/api/devices');
    final data = response.data;
    if (data is List) {
      return data.cast<Map<String, dynamic>>();
    }
    if (data is Map && data['devices'] is List) {
      return (data['devices'] as List).cast<Map<String, dynamic>>();
    }
    return [];
  }

  // --- Memory Search & Timeline ---

  Future<Map<String, dynamic>> searchMemory(
    String query, {
    bool semantic = true,
    int limit = 30,
    int offset = 0,
    String? deviceId,
  }) async {
    final response = await _dio.get(
      '/api/search',
      queryParameters: {
        'q': query,
        'semantic': semantic ? '1' : '0',
        'limit': limit,
        'offset': offset,
        if (deviceId != null && deviceId != 'all') 'device_id': deviceId,
      },
    );
    return response.data as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> getDocument(String id) async {
    final response = await _dio.get('/api/documents/$id');
    return response.data as Map<String, dynamic>;
  }

  // --- Daily Summaries ---

  Future<List<Map<String, dynamic>>> getDailyDates() async {
    final response = await _dio.get('/api/daily');
    if (response.data is List) {
      return (response.data as List).cast<Map<String, dynamic>>();
    }
    return [];
  }

  Future<Map<String, dynamic>> getDailyDetail(String date) async {
    final response = await _dio.get('/api/daily/$date');
    return response.data as Map<String, dynamic>;
  }

  // --- Ask Conversations ---

  Future<List<AskConversationSummary>> getAskConversations() async {
    final response = await _dio.get('/api/ask/conversations');
    final data = response.data;
    if (data is List) {
      return data
          .whereType<Map<String, dynamic>>()
          .map((j) => AskConversationSummary.fromJson(j))
          .toList();
    }
    return [];
  }

  Future<Map<String, dynamic>> getAskConversation(String id) async {
    final response = await _dio.get('/api/ask/conversations/$id');
    return response.data as Map<String, dynamic>;
  }

  Future<void> deleteAskConversation(String id) async {
    await _dio.delete('/api/ask/conversations/$id');
  }

  // --- Direct Command Dispatch ---

  Future<Map<String, dynamic>> dispatchCommand({
    required String deviceId,
    required String command,
    String? cwd,
  }) async {
    final response = await _dio.post(
      '/api/devices/$deviceId/commands',
      data: {
        'command': command,
        if (cwd != null && cwd.isNotEmpty) 'cwd': cwd,
      },
    );
    return response.data as Map<String, dynamic>;
  }

  // --- Projects & Historical Sessions ---

  Future<List<Map<String, dynamic>>> getProjects({String? toolId}) async {
    final response = await _dio.get(
      '/api/projects',
      queryParameters: {
        if (toolId != null && toolId.isNotEmpty) 'tool_id': toolId,
      },
    );
    final data = response.data;
    if (data is List) {
      return data.cast<Map<String, dynamic>>();
    }
    return [];
  }

  Future<Map<String, dynamic>> getProjectConversations(
    String projectId, {
    int limit = 30,
    String order = 'desc',
  }) async {
    final response = await _dio.get(
      '/api/projects/$projectId/conversations',
      queryParameters: {
        'session_limit': limit,
        'order': order,
      },
    );
    return response.data as Map<String, dynamic>;
  }
}

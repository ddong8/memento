import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'package:dio/dio.dart';
import '../models/ask_turn.dart';
import 'api_client.dart';
import 'background_task_service.dart';
import 'storage.dart';

/// Callbacks for the events of one ask run.
class AskStreamHandlers {
  final void Function(String id, String? title) onConversationId;
  final void Function(List<AskSource> sources) onSources;
  final void Function(ToolCallItem item) onToolCall;
  final void Function(String? taskId, String? toolCallId, String? deviceName, String? status) onTaskProgress;
  final void Function(String? taskId, String? toolCallId, String? deviceName, String stream, String text) onTaskChunk;
  final void Function(String? taskId, String? toolCallId, ToolCallResult result) onToolResult;
  final void Function(String? taskId, String? toolCallId, String? deviceName, Map<String, dynamic> alert)? onTaskAlert;
  final void Function(String text) onThinking;
  final void Function(String text) onDelta;
  final void Function(String error) onError;

  /// The run is no longer on the server (finished a while ago, or the server
  /// restarted): the saved conversation is now the source of truth.
  final void Function() onRunGone;

  /// Called once when following stops, whatever the reason.
  final void Function() onDone;

  const AskStreamHandlers({
    required this.onConversationId,
    required this.onSources,
    required this.onToolCall,
    required this.onTaskProgress,
    required this.onTaskChunk,
    required this.onToolResult,
    this.onTaskAlert,
    required this.onThinking,
    required this.onDelta,
    required this.onError,
    required this.onRunGone,
    required this.onDone,
  });
}

/// Streams an ask run from the server.
///
/// Runs live on the server independently of this connection: if the app goes to
/// the background and the socket drops, the run (and any device task) keeps
/// going. This client reattaches from the last event id it saw, so nothing is
/// resent or dispatched twice. Only [stop] ends the run itself.
/// One ask or attach call. Kept separate per call so a detached call that is
/// still unwinding can never read the state of the call that replaced it.
class _Follow {
  final CancelToken token = CancelToken();
  /// The HTTP request in flight; cancelling only this forces a reconnect.
  CancelToken? request;
  String? conversationId;
  int lastEventId;

  _Follow(this.conversationId, this.lastEventId);

  bool get cancelled => token.isCancelled;

  CancelToken newRequest() {
    final t = CancelToken();
    request = t;
    return t;
  }

  void cancel() {
    token.cancel('detached');
    request?.cancel('detached');
  }
}



class AskSseClient {
  /// The server sends a keepalive every 8 s; this long without any byte means the
  /// connection is dead (e.g. half-open after an iOS background suspension).
  final Duration idleTimeout;

  AskSseClient({this.idleTimeout = const Duration(seconds: 30)});

  _Follow? _current;

  /// Currently receiving (or reconnecting to) a run.
  bool get isFollowing => _current != null && !_current!.cancelled;

  /// Stop receiving; the run keeps going on the server.
  void detach() {
    _current?.cancel();
    _current = null;
  }

  /// Drop the current connection and resume from the last event right away,
  /// e.g. when the app returns to the foreground on a possibly dead socket.
  void reconnect() {
    final f = _current;
    if (f != null && f.conversationId != null) f.request?.cancel('reconnect');
  }

  /// Stop the run itself, including any device task it is waiting on.
  Future<void> stop(String? conversationId) async {
    final id = conversationId ?? _current?.conversationId;
    detach();
    if (id != null && id.isNotEmpty) {
      try {
        await ApiClient().cancelAskRun(id);
      } catch (_) {
        // Already finished, or unreachable: nothing left to stop from here.
      }
    }
  }

  static String _newRequestId() {
    final r = Random.secure();
    return List.generate(16, (_) => r.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
  }

  Options _streamOptions(String? token) => Options(
        responseType: ResponseType.stream,
        receiveTimeout: const Duration(hours: 2),
        headers: {
          'Accept': 'text/event-stream',
          if (token != null && token.isNotEmpty) 'Authorization': 'Bearer $token',
        },
      );

  Future<void> ask({
    required String question,
    String? conversationId,
    List<Map<String, dynamic>> history = const [],
    String selectedDevice = 'auto',
    String? cwd,
    String executionMode = 'ai',
    String? model,
    String? effort,
    String? projectId,
    String? sessionId,
    bool? compactMode,
    int? timeoutSeconds,
    List<String>? images,
    List<Map<String, dynamic>>? attachments,
    required AskStreamHandlers handlers,
  }) async {
    detach();
    // The conversation id is learned from this send's own stream, so a send that
    // never reached the server reports an error instead of "reattaching".
    final f = _current = _Follow(null, 0);
    await BackgroundTaskService.begin(name: 'memento_ask_stream');

    final serverUrl = await AppStorage.getServerUrl();
    final token = await AppStorage.getToken();
    final requestBody = {
      'question': question,
      // Retries reuse this id; the server attaches them to the first attempt's run.
      'request_id': _newRequestId(),
      if (conversationId != null && conversationId.isNotEmpty) 'conversation_id': conversationId,
      'history': history,
      'device_id': selectedDevice,
      if (cwd != null && cwd.trim().isNotEmpty) 'cwd': cwd.trim(),
      'agent_mode': selectedDevice != 'ask_only',
      'execution_mode': executionMode,
      if (model != null && model.isNotEmpty) 'model': model,
      if (effort != null && effort.isNotEmpty) 'effort': effort,
      if (projectId != null && projectId.isNotEmpty) 'project_id': projectId,
      if (sessionId != null && sessionId.isNotEmpty) 'session_id': sessionId,
      if (compactMode == true) 'compact_mode': true,
      if (timeoutSeconds != null && timeoutSeconds > 0) 'timeout_seconds': timeoutSeconds,
      if (images != null && images.isNotEmpty) 'images': images,
      if (attachments != null && attachments.isNotEmpty) 'attachments': attachments,
    };

    try {
      var done = false;
      const maxAttempts = 3;
      for (var attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          final response = await ApiClient().dio.post<ResponseBody>(
                '$serverUrl/api/ask',
                data: requestBody,
                options: _streamOptions(token),
                cancelToken: f.newRequest(),
              );
          done = await _consume(f, response.data!.stream, handlers);
          break;
        } catch (e) {
          if (f.cancelled) return;
          // The run exists server-side from here on: follow it, never resend.
          if (f.conversationId != null) break;
          if (e is DioException && e.response?.statusCode == 409) {
            handlers.onError('这个对话还有任务在运行，请等它结束或先停止');
            return;
          }
          if (_isRetryable(e) && attempt < maxAttempts) {
            await Future.delayed(Duration(milliseconds: 1200 * attempt));
            continue;
          }
          handlers.onError(_describe(e));
          return;
        }
      }
      if (!done && !f.cancelled && f.conversationId != null) {
        await _follow(f, serverUrl, token, handlers);
      }
    } finally {
      if (identical(_current, f)) _current = null;
      await BackgroundTaskService.end();
      handlers.onDone();
    }
  }

  /// Follow a run that's already going, e.g. after reopening its conversation.
  /// [after] is the last event id already applied (0 replays the whole run).
  Future<void> attach({
    required String conversationId,
    int after = 0,
    required AskStreamHandlers handlers,
  }) async {
    detach();
    final f = _current = _Follow(conversationId, after);
    try {
      final serverUrl = await AppStorage.getServerUrl();
      final token = await AppStorage.getToken();
      await _follow(f, serverUrl, token, handlers);
    } finally {
      if (identical(_current, f)) _current = null;
      handlers.onDone();
    }
  }

  /// Reattach from the last seen event until the run ends, backing off while the
  /// network (or an iOS background suspension) keeps the connection down.
  Future<void> _follow(_Follow f, String serverUrl, String? token, AskStreamHandlers handlers) async {
    var failures = 0;
    while (!f.cancelled) {
      try {
        final response = await ApiClient().dio.get<ResponseBody>(
              '$serverUrl/api/ask/conversations/${f.conversationId}/stream',
              queryParameters: {'after': f.lastEventId},
              options: _streamOptions(token),
              cancelToken: f.newRequest(),
            );
        final before = f.lastEventId;
        if (await _consume(f, response.data!.stream, handlers)) return;
        if (f.lastEventId > before) failures = 0;
      } on DioException catch (e) {
        if (f.cancelled) return;
        if (CancelToken.isCancel(e)) continue; // reconnect(): resume at once
        if (e.response?.statusCode == 404) {
          handlers.onRunGone();
          return;
        }
      } catch (_) {
        if (f.cancelled) return;
      }
      failures++;
      await Future.delayed(Duration(seconds: min(2 * failures, 15)));
    }
  }

  /// Read one SSE response, dispatching events. Returns true once the run is done.
  Future<bool> _consume(_Follow f, Stream<List<int>> body, AskStreamHandlers h) async {
    var buffer = '';
    var done = false;

    void processFrame(String frame) {
      for (final line in frame.split('\n')) {
        if (line.startsWith('id: ')) {
          final id = int.tryParse(line.substring(4).trim());
          if (id != null) f.lastEventId = id;
          continue;
        }
        if (!line.startsWith('data: ')) continue;
        final jsonStr = line.substring(6).trim();
        if (jsonStr.isEmpty) continue;
        try {
          final Map<String, dynamic> evt = jsonDecode(jsonStr);
          switch (evt['type']?.toString()) {
            case 'conversation_id':
              if (evt['id'] != null) {
                f.conversationId = evt['id'].toString();
                h.onConversationId(f.conversationId!, evt['title']?.toString());
              }
            case 'sources':
              if (evt['sources'] is List) {
                h.onSources((evt['sources'] as List)
                    .map((s) => AskSource.fromJson(s as Map<String, dynamic>))
                    .toList());
              }
            case 'tool_call':
              h.onToolCall(ToolCallItem(
                id: (evt['id'] ?? evt['tool_call_id'])?.toString() ??
                    DateTime.now().millisecondsSinceEpoch.toString(),
                name: evt['name']?.toString() ?? '',
                args: (evt['args'] as Map<String, dynamic>?) ?? {},
                deviceName: evt['device_name']?.toString(),
              ));
            case 'task_progress':
              h.onTaskProgress(evt['task_id']?.toString(), evt['tool_call_id']?.toString(),
                  evt['device_name']?.toString(), evt['status']?.toString());
            case 'task_chunk':
              h.onTaskChunk(evt['task_id']?.toString(), evt['tool_call_id']?.toString(),
                  evt['device_name']?.toString(), evt['stream']?.toString() ?? 'stdout', evt['text']?.toString() ?? '');
            case 'task_alert':
              if (evt['alert'] is Map) {
                h.onTaskAlert?.call(evt['task_id']?.toString(), evt['tool_call_id']?.toString(),
                    evt['device_name']?.toString(), (evt['alert'] as Map).cast<String, dynamic>());
              }
            case 'tool_result':
              h.onToolResult(evt['task_id']?.toString(), evt['tool_call_id']?.toString(),
                  ToolCallResult.fromJson(evt['result'] as Map<String, dynamic>? ?? {}));
            case 'thinking':
              if (evt['text'] != null) h.onThinking(evt['text'].toString());
            case 'delta':
              if (evt['text'] != null) h.onDelta(evt['text'].toString());
            case 'done':
              done = true;
            case 'error':
              h.onError(evt['message']?.toString() ?? '发生未知错误');
          }
        } catch (_) {
          // Ignore a single malformed frame.
        }
      }
    }

    final bytes = body.cast<List<int>>().timeout(idleTimeout);
    await for (final text in bytes.transform(const Utf8Decoder(allowMalformed: true))) {
      buffer += text;
      final frames = buffer.split('\n\n');
      buffer = frames.removeLast();
      for (final frame in frames) {
        processFrame(frame);
      }
    }
    if (buffer.trim().isNotEmpty) processFrame(buffer);
    return done;
  }

  static bool _isRetryable(Object e) {
    if (e is DioException) {
      final code = e.response?.statusCode;
      return e.type == DioExceptionType.connectionError ||
          e.type == DioExceptionType.connectionTimeout ||
          e.type == DioExceptionType.sendTimeout ||
          (code != null && code >= 502 && code <= 504) ||
          _isConnectionDrop(e);
    }
    return _isConnectionDrop(e);
  }

  static String _describe(Object e) {
    if (e is DioException) {
      final code = e.response?.statusCode;
      if (code != null && code >= 500) return '服务端暂时繁忙或正在重启升级（HTTP $code），请稍候重试';
      if (e.type == DioExceptionType.connectionError ||
          e.type == DioExceptionType.connectionTimeout ||
          e.type == DioExceptionType.sendTimeout) {
        return '网络连接不可用，请检查网络后重试';
      }
      if (_isConnectionDrop(e)) return '服务器连接中断（无响应或网络波动），请点击重试';
      return '网络请求失败: ${e.message ?? e}';
    }
    if (_isConnectionDrop(e)) return '服务器连接中断（无响应或网络波动），请点击重试';
    return '请求异常: $e';
  }

  static bool _isConnectionDrop(Object e) {
    final s = e is DioException ? '${e.error} ${e.message}' : e.toString();
    return s.contains('Connection closed') ||
        s.contains('Connection reset') ||
        s.contains('Software caused connection abort') ||
        s.contains('SocketException');
  }
}

import 'dart:async';
import 'dart:convert';
import 'package:dio/dio.dart';
import '../models/ask_turn.dart';
import 'api_client.dart';
import 'background_task_service.dart';
import 'storage.dart';

class AskSseClient {
  CancelToken? _cancelToken;

  void abort() {
    _cancelToken?.cancel('User aborted');
    _cancelToken = null;
  }

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
    required void Function(String id, String? title) onConversationId,
    required void Function(List<AskSource> sources) onSources,
    required void Function(ToolCallItem item) onToolCall,
    required void Function(
      String? taskId,
      String? toolCallId,
      String? deviceName,
      String? status,
    ) onTaskProgress,
    required void Function(
      String? taskId,
      String? toolCallId,
      String? deviceName,
      String stream,
      String text,
    ) onTaskChunk,
    required void Function(
      String? taskId,
      String? toolCallId,
      ToolCallResult result,
    ) onToolResult,
    void Function(
      String? taskId,
      String? toolCallId,
      String? deviceName,
      Map<String, dynamic> alert,
    )? onTaskAlert,
    required void Function(String text) onThinking,
    required void Function(String text) onDelta,
    required void Function(String error) onError,
    required void Function() onDone,
  }) async {
    _cancelToken = CancelToken();
    await BackgroundTaskService.begin(name: 'memento_ask_stream');

    final serverUrl = await AppStorage.getServerUrl();
    final token = await AppStorage.getToken();

    final dio = ApiClient().dio;
    bool isDone = false;
    bool hasReceivedContent = false;

    final requestBody = {
      'question': question,
      if (conversationId != null && conversationId.isNotEmpty)
        'conversation_id': conversationId,
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
      if (timeoutSeconds != null && timeoutSeconds > 0)
        'timeout_seconds': timeoutSeconds,
      if (images != null && images.isNotEmpty) 'images': images,
      if (attachments != null && attachments.isNotEmpty)
        'attachments': attachments,
    };

    const maxRetries = 2;

    try {
      for (int attempt = 1; attempt <= maxRetries; attempt++) {
        try {
        final response = await dio.post<ResponseBody>(
          '$serverUrl/api/ask',
          data: requestBody,
          options: Options(
            responseType: ResponseType.stream,
            receiveTimeout: const Duration(hours: 2),
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'text/event-stream',
              if (token != null && token.isNotEmpty)
                'Authorization': 'Bearer $token',
            },
          ),
          cancelToken: _cancelToken,
        );

        final stream = response.data?.stream;
        if (stream == null) {
          if (attempt < maxRetries && !(_cancelToken?.isCancelled ?? false)) {
            await Future.delayed(const Duration(milliseconds: 1200));
            continue;
          }
          onError('无法获取服务器响应数据流，请检查网络连接后重试');
          return;
        }

        String buffer = '';

        void processFrame(String frame) {
          final lines = frame.split('\n');
          for (final line in lines) {
            if (!line.startsWith('data: ')) continue;
            final jsonStr = line.substring(6).trim();
            if (jsonStr.isEmpty) continue;

            try {
              final Map<String, dynamic> evt = jsonDecode(jsonStr);
              final type = evt['type']?.toString();

              if (type == 'conversation_id' && evt['id'] != null) {
                onConversationId(evt['id'].toString(), evt['title']?.toString());
              } else if (type == 'sources' && evt['sources'] is List) {
                final list = (evt['sources'] as List)
                    .map((s) => AskSource.fromJson(s as Map<String, dynamic>))
                    .toList();
                onSources(list);
              } else if (type == 'tool_call') {
                final item = ToolCallItem(
                  id: (evt['id'] ?? evt['tool_call_id'])?.toString() ??
                      DateTime.now().millisecondsSinceEpoch.toString(),
                  name: evt['name']?.toString() ?? '',
                  args: (evt['args'] as Map<String, dynamic>?) ?? {},
                  deviceName: evt['device_name']?.toString(),
                );
                onToolCall(item);
              } else if (type == 'task_progress') {
                onTaskProgress(
                  evt['task_id']?.toString(),
                  evt['tool_call_id']?.toString(),
                  evt['device_name']?.toString(),
                  evt['status']?.toString(),
                );
              } else if (type == 'task_chunk') {
                onTaskChunk(
                  evt['task_id']?.toString(),
                  evt['tool_call_id']?.toString(),
                  evt['device_name']?.toString(),
                  evt['stream']?.toString() ?? 'stdout',
                  evt['text']?.toString() ?? '',
                );
              } else if (type == 'task_alert' && evt['alert'] is Map) {
                onTaskAlert?.call(
                  evt['task_id']?.toString(),
                  evt['tool_call_id']?.toString(),
                  evt['device_name']?.toString(),
                  (evt['alert'] as Map).cast<String, dynamic>(),
                );
              } else if (type == 'tool_result') {
                final resJson = evt['result'] as Map<String, dynamic>? ?? {};
                onToolResult(
                  evt['task_id']?.toString(),
                  evt['tool_call_id']?.toString(),
                  ToolCallResult.fromJson(resJson),
                );
              } else if (type == 'thinking' && evt['text'] != null) {
                hasReceivedContent = true;
                onThinking(evt['text'].toString());
              } else if (type == 'delta' && evt['text'] != null) {
                hasReceivedContent = true;
                onDelta(evt['text'].toString());
              } else if (type == 'done') {
                isDone = true;
              } else if (type == 'error') {
                onError(evt['message']?.toString() ?? '发生未知错误');
              }
            } catch (_) {
              // Ignore single malformed frame
            }
          }
        }

        final stringStream = stream
            .cast<List<int>>()
            .transform(const Utf8Decoder(allowMalformed: true));

        try {
          await for (final text in stringStream) {
            buffer += text;
            final frames = buffer.split('\n\n');
            buffer = frames.removeLast();

            for (final frame in frames) {
              processFrame(frame);
            }
          }
        } catch (streamErr) {
          // Drain any remaining buffer text
          if (buffer.trim().isNotEmpty) {
            processFrame(buffer);
            buffer = '';
          }

          final errStr = streamErr.toString();
          final isSocketClosed = errStr.contains('Connection closed') ||
              errStr.contains('Connection reset by peer') ||
              errStr.contains('Software caused connection abort') ||
              errStr.contains('HttpException: Connection closed') ||
              errStr.contains('SocketException');

          if (isDone) {
            // Normal termination: server terminated connection after sending 'done'
          } else if (isSocketClosed && hasReceivedContent) {
            // Output was already received and streamed to user; treat connection close as completion
            isDone = true;
          } else if (isSocketClosed &&
              !hasReceivedContent &&
              attempt < maxRetries &&
              !(_cancelToken?.isCancelled ?? false)) {
            await Future.delayed(const Duration(milliseconds: 1200));
            continue;
          } else {
            rethrow;
          }
        }

        if (buffer.trim().isNotEmpty) {
          processFrame(buffer);
        }

        // Successfully finished streaming
        break;
      } on DioException catch (e) {
        if (CancelToken.isCancel(e)) return;
        if (isDone) break;

        final isRetryable = e.type == DioExceptionType.connectionError ||
            e.type == DioExceptionType.connectionTimeout ||
            e.type == DioExceptionType.sendTimeout ||
            (e.response?.statusCode != null &&
                e.response!.statusCode! >= 502 &&
                e.response!.statusCode! <= 504);

        if (isRetryable &&
            !hasReceivedContent &&
            attempt < maxRetries &&
            !(_cancelToken?.isCancelled ?? false)) {
          await Future.delayed(const Duration(milliseconds: 1200));
          continue;
        }

        if (hasReceivedContent &&
            (e.error?.toString().contains('Connection closed') == true ||
                e.message?.contains('Connection closed') == true)) {
          // Response was received but connection closed before done event
          onDelta('\n\n> ⚠️ *[网络连接提前中断，若回答未完成可发送“继续”]*');
        } else if (e.type == DioExceptionType.receiveTimeout ||
            e.type == DioExceptionType.connectionTimeout ||
            e.type == DioExceptionType.sendTimeout ||
            e.type == DioExceptionType.connectionError) {
          onError('网络连接不稳定或中断（如切到后台或网络波动），请检查网络后重试');
        } else if (e.response?.statusCode != null && e.response!.statusCode! >= 500) {
          onError('服务端暂时繁忙或正在重启升级（HTTP ${e.response?.statusCode}），请稍候重试');
        } else {
          onError('网络请求失败: ${e.message ?? e.toString()}');
        }
        return;
      } catch (e) {
        if (isDone) break;

        final errStr = e.toString();
        final isSocketClosed = errStr.contains('Connection closed') ||
            errStr.contains('HttpException: Connection closed') ||
            errStr.contains('Software caused connection abort') ||
            errStr.contains('SocketException') ||
            errStr.contains('Connection reset by peer');

        if (isSocketClosed &&
            !hasReceivedContent &&
            attempt < maxRetries &&
            !(_cancelToken?.isCancelled ?? false)) {
          await Future.delayed(const Duration(milliseconds: 1200));
          continue;
        }

        if (hasReceivedContent && isSocketClosed) {
          // Content was received but closed before done
          onDelta('\n\n> ⚠️ *[连接提前中断，若回答未完成可发送“继续”]*');
        } else if (errStr.contains('SocketException') ||
            errStr.contains('Connection refused') ||
            errStr.contains('Network is unreachable')) {
          onError('网络连接不可用，请检查网络连接后重试');
        } else if (isSocketClosed) {
          onError('服务器连接中断（无响应或网络波动），请点击重试');
        } else {
          onError('请求异常: $e');
        }
        return;
      }
    }
    } finally {
      await BackgroundTaskService.end();
      _cancelToken = null;
      onDone();
    }
  }
}

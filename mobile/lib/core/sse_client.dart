import 'dart:async';
import 'dart:convert';
import 'package:dio/dio.dart';
import '../models/ask_turn.dart';
import 'api_client.dart';
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
    required void Function(String id) onConversationId,
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
    required void Function(String text) onThinking,
    required void Function(String text) onDelta,
    required void Function(String error) onError,
    required void Function() onDone,
  }) async {
    _cancelToken = CancelToken();

    final serverUrl = await AppStorage.getServerUrl();
    final token = await AppStorage.getToken();

    final dio = ApiClient().dio;

    try {
      final response = await dio.post<ResponseBody>(
        '$serverUrl/api/ask',
        data: {
          'question': question,
          if (conversationId != null && conversationId.isNotEmpty)
            'conversation_id': conversationId,
          'history': history,
          'device_id': selectedDevice,
          if (cwd != null && cwd.trim().isNotEmpty) 'cwd': cwd.trim(),
          'agent_mode': selectedDevice != 'ask_only',
        },
        options: Options(
          responseType: ResponseType.stream,
          receiveTimeout: const Duration(minutes: 10),
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
        onError('无法获取服务器响应数据流');
        onDone();
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
              onConversationId(evt['id'].toString());
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
            } else if (type == 'tool_result') {
              final resJson = evt['result'] as Map<String, dynamic>? ?? {};
              onToolResult(
                evt['task_id']?.toString(),
                evt['tool_call_id']?.toString(),
                ToolCallResult.fromJson(resJson),
              );
            } else if (type == 'thinking' && evt['text'] != null) {
              onThinking(evt['text'].toString());
            } else if (type == 'delta' && evt['text'] != null) {
              onDelta(evt['text'].toString());
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

      await for (final text in stringStream) {
        buffer += text;
        final frames = buffer.split('\n\n');
        buffer = frames.removeLast();

        for (final frame in frames) {
          processFrame(frame);
        }
      }

      if (buffer.trim().isNotEmpty) {
        processFrame(buffer);
      }
    } on DioException catch (e) {
      if (CancelToken.isCancel(e)) {
        // user aborted
      } else if (e.type == DioExceptionType.receiveTimeout ||
          e.type == DioExceptionType.connectionTimeout ||
          e.type == DioExceptionType.connectionError) {
        onError('网络连接中断（如切到后台或网络波动导致挂起），请回到前台后重试');
      } else {
        onError('网络请求失败: ${e.message ?? e.toString()}');
      }
    } catch (e) {
      onError('请求异常: $e');
    } finally {
      _cancelToken = null;
      onDone();
    }
  }
}

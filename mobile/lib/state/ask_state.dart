import 'dart:async';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../core/sse_client.dart';
import '../models/ask_turn.dart';

class AskState {
  final List<AskTurn> turns;
  final bool isStreaming;
  final String? activeConversationId;
  final String? error;

  AskState({
    this.turns = const [],
    this.isStreaming = false,
    this.activeConversationId,
    this.error,
  });

  AskState copyWith({
    List<AskTurn>? turns,
    bool? isStreaming,
    String? activeConversationId,
    String? error,
  }) {
    return AskState(
      turns: turns ?? this.turns,
      isStreaming: isStreaming ?? this.isStreaming,
      activeConversationId: activeConversationId ?? this.activeConversationId,
      error: error,
    );
  }
}

class AskNotifier extends StateNotifier<AskState> {
  final AskSseClient _sseClient = AskSseClient();
  Timer? _batchTimer;
  String _pendingDelta = '';
  String _pendingThinking = '';

  AskNotifier() : super(AskState());

  void _flushPending() {
    _batchTimer?.cancel();
    _batchTimer = null;
    if (_pendingDelta.isEmpty && _pendingThinking.isEmpty) return;

    final delta = _pendingDelta;
    final thinking = _pendingThinking;
    _pendingDelta = '';
    _pendingThinking = '';

    _updateLastAssistantSync((prev) => prev.copyWith(
      content: prev.content + delta,
      thinking: (prev.thinking ?? '') + thinking,
    ));
  }

  void _scheduleBatchFlush() {
    if (_batchTimer != null && _batchTimer!.isActive) return;
    _batchTimer = Timer(const Duration(milliseconds: 50), () {
      _flushPending();
    });
  }

  void newChat() {
    _sseClient.abort();
    _flushPending();
    state = AskState();
  }

  void clearChat() {
    _sseClient.abort();
    _flushPending();
    state = state.copyWith(turns: []);
  }

  void abort() {
    _sseClient.abort();
    _flushPending();
    state = state.copyWith(isStreaming: false);
  }

  void _updateLastAssistantSync(AskTurn Function(AskTurn prev) fn) {
    if (state.turns.isEmpty) return;
    final list = [...state.turns];
    final lastIdx = list.length - 1;
    if (list[lastIdx].role == 'assistant') {
      list[lastIdx] = fn(list[lastIdx]);
      state = state.copyWith(turns: list);
    }
  }

  Future<void> sendQuestion({
    required String question,
    required String selectedDevice,
    String? cwd,
  }) async {
    if (question.trim().isEmpty || state.isStreaming) return;

    _flushPending();

    // 1. Add user turn
    final userTurn = AskTurn(role: 'user', content: question.trim());
    final assistantTurn = AskTurn(role: 'assistant', content: '');

    final updatedTurns = [...state.turns, userTurn, assistantTurn];
    state = state.copyWith(
      turns: updatedTurns,
      isStreaming: true,
      error: null,
    );

    // Build history for backend
    final history = state.turns
        .map((t) => {'role': t.role, 'content': t.content})
        .toList();

    await _sseClient.ask(
      question: question.trim(),
      conversationId: state.activeConversationId,
      history: history,
      selectedDevice: selectedDevice,
      cwd: cwd,
      onConversationId: (id) {
        state = state.copyWith(activeConversationId: id);
      },
      onSources: (sources) {
        _flushPending();
        _updateLastAssistantSync((prev) => prev.copyWith(sources: sources));
      },
      onToolCall: (item) {
        _flushPending();
        _updateLastAssistantSync((prev) {
          final calls = [...prev.toolCalls, item];
          return prev.copyWith(toolCalls: calls);
        });
      },
      onTaskProgress: (taskId, toolCallId, deviceName, status) {
        _flushPending();
        _updateLastAssistantSync((prev) {
          final calls = [...prev.toolCalls];
          final idx = _findCallIndex(calls, taskId, toolCallId, deviceName);
          if (idx >= 0) {
            final target = calls[idx];
            calls[idx] = target.copyWith(
              deviceName: deviceName ?? target.deviceName,
              result: (target.result ?? ToolCallResult()).copyWith(
                taskId: taskId,
                deviceName: deviceName ?? target.deviceName,
                status: status,
              ),
            );
          }
          return prev.copyWith(toolCalls: calls);
        });
      },
      onTaskChunk: (taskId, toolCallId, deviceName, stream, text) {
        _flushPending();
        _updateLastAssistantSync((prev) {
          final calls = [...prev.toolCalls];
          final idx = _findCallIndex(calls, taskId, toolCallId, deviceName);
          if (idx >= 0) {
            final target = calls[idx];
            final prevRes = target.result ?? ToolCallResult();
            if (stream == 'stderr') {
              calls[idx] = target.copyWith(
                result: prevRes.copyWith(
                  taskId: taskId ?? prevRes.taskId,
                  status: 'running',
                  stderr: (prevRes.stderr ?? '') + text,
                ),
              );
            } else {
              calls[idx] = target.copyWith(
                result: prevRes.copyWith(
                  taskId: taskId ?? prevRes.taskId,
                  status: 'running',
                  stdout: (prevRes.stdout ?? '') + text,
                ),
              );
            }
          }
          return prev.copyWith(toolCalls: calls);
        });
      },
      onToolResult: (taskId, toolCallId, result) {
        _flushPending();
        _updateLastAssistantSync((prev) {
          final calls = [...prev.toolCalls];
          final idx = _findCallIndex(calls, taskId, toolCallId, result.deviceName);
          if (idx >= 0) {
            calls[idx] = calls[idx].copyWith(result: result);
          } else if (calls.isNotEmpty) {
            calls[calls.length - 1] =
                calls[calls.length - 1].copyWith(result: result);
          }
          return prev.copyWith(toolCalls: calls);
        });
      },
      onThinking: (chunk) {
        _pendingThinking += chunk;
        _scheduleBatchFlush();
      },
      onDelta: (chunk) {
        _pendingDelta += chunk;
        _scheduleBatchFlush();
      },
      onError: (err) {
        _flushPending();
        _updateLastAssistantSync((prev) {
          if (prev.content.trim().isNotEmpty) {
            return prev.copyWith(
              content: '${prev.content}\n\n> ⚠️ *($err)*',
              error: false,
            );
          }
          return prev.copyWith(content: err, error: true);
        });
        state = state.copyWith(error: err, isStreaming: false);
      },
      onDone: () {
        _flushPending();
        state = state.copyWith(isStreaming: false);
      },
    );
  }

  int _findCallIndex(
    List<ToolCallItem> calls,
    String? taskId,
    String? toolCallId,
    String? deviceName,
  ) {
    if (taskId != null) {
      final idx = calls.indexWhere((c) => c.result?.taskId == taskId);
      if (idx >= 0) return idx;
    }
    if (toolCallId != null) {
      final idx = calls.indexWhere((c) => c.id == toolCallId);
      if (idx >= 0) return idx;
    }
    if (deviceName != null) {
      final idx = calls.indexWhere((c) =>
          c.deviceName == deviceName &&
          (c.result?.status == null ||
              c.result?.status == 'queued' ||
              c.result?.status == 'running'));
      if (idx >= 0) return idx;
    }
    return calls.isNotEmpty ? calls.length - 1 : -1;
  }
}

final askProvider = StateNotifierProvider<AskNotifier, AskState>((ref) {
  return AskNotifier();
});

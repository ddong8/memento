import 'dart:async';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../core/api_client.dart';
import '../core/sse_client.dart';
import '../core/storage.dart';
import '../models/ask_turn.dart';
import '../models/chat_attachment.dart';

class AskState {
  final List<AskTurn> turns;
  final bool isStreaming;
  final String? activeConversationId;
  final String? activeConversationTitle;
  final String? error;
  final bool isLoadingHistory;

  AskState({
    this.turns = const [],
    this.isStreaming = false,
    this.activeConversationId,
    this.activeConversationTitle,
    this.error,
    this.isLoadingHistory = false,
  });

  AskState copyWith({
    List<AskTurn>? turns,
    bool? isStreaming,
    String? activeConversationId,
    bool clearActiveConversationId = false,
    String? activeConversationTitle,
    bool clearActiveConversationTitle = false,
    String? error,
    bool? isLoadingHistory,
  }) {
    return AskState(
      turns: turns ?? this.turns,
      isStreaming: isStreaming ?? this.isStreaming,
      activeConversationId: clearActiveConversationId
          ? null
          : (activeConversationId ?? this.activeConversationId),
      activeConversationTitle: clearActiveConversationTitle
          ? null
          : (activeConversationTitle ?? this.activeConversationTitle),
      error: error,
      isLoadingHistory: isLoadingHistory ?? this.isLoadingHistory,
    );
  }
}

class AskNotifier extends StateNotifier<AskState> {
  final AskSseClient _sseClient = AskSseClient();
  Timer? _batchTimer;
  String _pendingDelta = '';
  String _pendingThinking = '';

  /// Bumped whenever the stream being shown changes (send, attach, switch, clear),
  /// so callbacks still arriving from a detached stream are ignored.
  int _generation = 0;

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

  /// Stop showing the current stream. The run itself keeps going on the server.
  void _detach() {
    _generation++;
    _sseClient.detach();
    _flushPending();
  }

  void newChat() {
    _detach();
    state = AskState();
    AppStorage.setLastAskConversationId(null);
  }

  void clearChat() {
    _detach();
    state = state.copyWith(turns: [], isStreaming: false);
  }

  void setSessionTurns(List<AskTurn> turns, {String? title}) {
    _detach();
    state = state.copyWith(
      turns: turns,
      isStreaming: false,
      clearActiveConversationId: true,
      activeConversationTitle: title,
      error: null,
    );
    AppStorage.setLastAskConversationId(null);
  }

  Future<void> loadConversation(
    String id, {
    void Function(String? deviceId, String? cwd)? onMetaLoaded,
  }) async {
    _detach();
    state = state.copyWith(isLoadingHistory: true, isStreaming: false, error: null);

    try {
      final res = await ApiClient().getAskConversation(id);
      final rawTurns = res['turns'] as List<dynamic>? ?? [];
      final turns = rawTurns
          .whereType<Map<String, dynamic>>()
          .map((t) => AskTurn.fromJson(t))
          .toList();

      state = state.copyWith(
        activeConversationId: id,
        activeConversationTitle: res['title']?.toString(),
        turns: turns,
        isLoadingHistory: false,
        isStreaming: false,
        error: null,
      );

      AppStorage.setLastAskConversationId(id);

      onMetaLoaded?.call(
        res['device_id']?.toString(),
        res['cwd']?.toString(),
      );

      // Still running (e.g. started before the app was closed, or from another device)?
      await _attachIfRunning(id);
    } catch (e) {
      state = state.copyWith(
        isLoadingHistory: false,
        error: '加载对话失败: $e',
      );
    }
  }

  /// If [id] has a run in progress on the server, show it live: add its question
  /// and an empty answer, then replay the run's events into them.
  Future<void> _attachIfRunning(String id) async {
    Map<String, dynamic>? run;
    try {
      run = await ApiClient().getAskRun(id);
    } catch (_) {
      return;
    }
    if (run == null || run['done'] == true || state.activeConversationId != id) return;

    _detach();
    final gen = _generation;
    state = state.copyWith(
      turns: [
        ...state.turns,
        AskTurn(role: 'user', content: run['question']?.toString() ?? ''),
        AskTurn(role: 'assistant', content: ''),
      ],
      isStreaming: true,
      error: null,
    );
    await _sseClient.attach(conversationId: id, after: 0, handlers: _handlers(gen));
  }

  /// Called when the app returns to the foreground.
  ///
  /// A stream that dropped while in the background reconnects by itself (from the
  /// last event it saw). This covers the rest: a run started elsewhere while we
  /// were away, or one that has already finished and been saved.
  Future<void> syncOnForegroundResumed() async {
    final activeId = state.activeConversationId;
    if (activeId == null || activeId.isEmpty) return;
    if (_sseClient.isFollowing) {
      // The socket may have died while suspended; resume from the last event now.
      _sseClient.reconnect();
      return;
    }

    Map<String, dynamic>? run;
    try {
      run = await ApiClient().getAskRun(activeId);
    } catch (_) {
      return;
    }
    if (run != null && run['done'] != true) {
      await _reloadFromServer(activeId);
      await _attachIfRunning(activeId);
      return;
    }

    final lastTurn = state.turns.isNotEmpty ? state.turns.last : null;
    final needsSync = state.isStreaming ||
        state.error != null ||
        (lastTurn != null && lastTurn.role == 'assistant' && lastTurn.content.isEmpty);
    if (needsSync) await _reloadFromServer(activeId);
  }

  /// Replace the shown turns with the saved conversation.
  Future<void> _reloadFromServer(String id) async {
    try {
      final res = await ApiClient().getAskConversation(id);
      if (state.activeConversationId != id) return;
      final serverTurns = (res['turns'] as List<dynamic>? ?? [])
          .whereType<Map<String, dynamic>>()
          .map((t) => AskTurn.fromJson(t))
          .toList();
      _flushPending();
      state = state.copyWith(
        turns: serverTurns,
        isStreaming: false,
        error: null,
        activeConversationTitle: res['title']?.toString() ?? state.activeConversationTitle,
      );
    } catch (_) {
      // Silently ignore network errors; the next resume retries.
    }
  }

  Future<void> deleteConversation(String id) async {
    try {
      if (state.activeConversationId == id && state.isStreaming) {
        await _sseClient.stop(id);
      }
      await ApiClient().deleteAskConversation(id);
      if (state.activeConversationId == id) {
        newChat();
      }
    } catch (e) {
      state = state.copyWith(error: '删除对话失败: $e');
    }
  }

  /// The stop button: ends the run on the server, including its device tasks.
  Future<void> abort() async {
    final id = state.activeConversationId;
    _generation++;
    _flushPending();
    state = state.copyWith(isStreaming: false);
    await _sseClient.stop(id);
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
    String executionMode = 'ai',
    String? model,
    String? effort,
    String? projectId,
    String? sessionId,
    bool? compactMode,
    int? timeoutSeconds,
    List<ChatAttachment>? attachments,
  }) async {
    final effectiveQuestion = question.trim().isNotEmpty
        ? question.trim()
        : (attachments != null && attachments.isNotEmpty
            ? '请查看并分析我发送的附件与截图。'
            : '');

    if (effectiveQuestion.isEmpty || state.isStreaming) return;

    _detach();
    final gen = _generation;

    final imageList = <String>[];
    final attachmentDataList = <Map<String, dynamic>>[];

    if (attachments != null && attachments.isNotEmpty) {
      for (final att in attachments) {
        if (att.isImage) {
          final url = att.dataUrl;
          if (url != null) imageList.add(url);
        }
        attachmentDataList.add(att.toJson());
      }
    }

    // 1. Add user turn with images and attachments
    final userTurn = AskTurn(
      role: 'user',
      content: effectiveQuestion,
      images: imageList,
      attachments: attachmentDataList,
    );
    final assistantTurn = AskTurn(role: 'assistant', content: '');

    final updatedTurns = [...state.turns, userTurn, assistantTurn];
    state = state.copyWith(
      turns: updatedTurns,
      isStreaming: true,
      error: null,
    );

    // Build history for backend (include text content)
    final history = state.turns
        .map((t) => {'role': t.role, 'content': t.content})
        .toList();

    await _sseClient.ask(
      question: effectiveQuestion,
      conversationId: state.activeConversationId,
      history: history,
      selectedDevice: selectedDevice,
      cwd: cwd,
      executionMode: executionMode,
      model: model,
      effort: effort,
      projectId: projectId,
      sessionId: sessionId,
      compactMode: compactMode,
      timeoutSeconds: timeoutSeconds,
      images: imageList.isNotEmpty ? imageList : null,
      attachments: attachmentDataList.isNotEmpty ? attachmentDataList : null,
      handlers: _handlers(gen),
    );
  }

  /// Event handlers bound to stream generation [gen]; stale ones do nothing.
  AskStreamHandlers _handlers(int gen) {
    bool live() => gen == _generation;
    return AskStreamHandlers(
      onConversationId: (id, title) {
        if (!live()) return;
        state = state.copyWith(
          activeConversationId: id,
          activeConversationTitle: title ?? state.activeConversationTitle,
        );
        AppStorage.setLastAskConversationId(id);
      },
      onSources: (sources) {
        if (!live()) return;
        _flushPending();
        _updateLastAssistantSync((prev) => prev.copyWith(sources: sources));
      },
      onToolCall: (item) {
        if (!live()) return;
        _flushPending();
        _updateLastAssistantSync((prev) {
          final calls = [...prev.toolCalls, item];
          return prev.copyWith(toolCalls: calls);
        });
      },
      onTaskProgress: (taskId, toolCallId, deviceName, status) {
        if (!live()) return;
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
        if (!live()) return;
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
      onTaskAlert: (taskId, toolCallId, deviceName, alert) {
        if (!live()) return;
        _flushPending();
        _updateLastAssistantSync((prev) {
          final calls = [...prev.toolCalls];
          final idx = _findCallIndex(calls, taskId, toolCallId, deviceName);
          if (idx >= 0) {
            final prevRes = calls[idx].result ?? ToolCallResult();
            calls[idx] = calls[idx].copyWith(
              result: prevRes.copyWith(
                taskId: taskId ?? prevRes.taskId,
                alerts: [...prevRes.alerts, alert],
              ),
            );
          }
          return prev.copyWith(toolCalls: calls);
        });
      },
      onToolResult: (taskId, toolCallId, result) {
        if (!live()) return;
        _flushPending();
        _updateLastAssistantSync((prev) {
          final calls = [...prev.toolCalls];
          final idx = _findCallIndex(calls, taskId, toolCallId, result.deviceName);
          if (idx >= 0) {
            // Older servers don't send alerts in the final result; keep the streamed ones.
            final streamed = calls[idx].result?.alerts ?? const <Map<String, dynamic>>[];
            calls[idx] = calls[idx].copyWith(
              result: result.alerts.isEmpty && streamed.isNotEmpty ? result.copyWith(alerts: streamed) : result,
            );
          } else if (calls.isNotEmpty) {
            calls[calls.length - 1] =
                calls[calls.length - 1].copyWith(result: result);
          }
          return prev.copyWith(toolCalls: calls);
        });
      },
      onThinking: (chunk) {
        if (!live()) return;
        _pendingThinking += chunk;
        _scheduleBatchFlush();
      },
      onDelta: (chunk) {
        if (!live()) return;
        _pendingDelta += chunk;
        _scheduleBatchFlush();
      },
      onError: (err) {
        if (!live()) return;
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
      onRunGone: () {
        if (!live()) return;
        final id = state.activeConversationId;
        if (id != null) unawaited(_reloadFromServer(id));
      },
      onDone: () {
        if (!live()) return;
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

class ToolCallResult {
  final String? taskId;
  final String? deviceId;
  final String? deviceName;
  final String? action;
  final String? status;
  final String? stdout;
  final String? stderr;
  final String? error;
  final int? exitCode;
  final List<dynamic>? devices;

  ToolCallResult({
    this.taskId,
    this.deviceId,
    this.deviceName,
    this.action,
    this.status,
    this.stdout,
    this.stderr,
    this.error,
    this.exitCode,
    this.devices,
  });

  factory ToolCallResult.fromJson(Map<String, dynamic> json) {
    return ToolCallResult(
      taskId: json['task_id']?.toString(),
      deviceId: json['device_id']?.toString(),
      deviceName: json['device_name']?.toString(),
      action: json['action']?.toString(),
      status: json['status']?.toString(),
      stdout: json['stdout']?.toString(),
      stderr: json['stderr']?.toString(),
      error: json['error']?.toString(),
      exitCode: json['exit_code'] as int?,
      devices: json['devices'] as List<dynamic>?,
    );
  }

  ToolCallResult copyWith({
    String? taskId,
    String? deviceId,
    String? deviceName,
    String? action,
    String? status,
    String? stdout,
    String? stderr,
    String? error,
    int? exitCode,
    List<dynamic>? devices,
  }) {
    return ToolCallResult(
      taskId: taskId ?? this.taskId,
      deviceId: deviceId ?? this.deviceId,
      deviceName: deviceName ?? this.deviceName,
      action: action ?? this.action,
      status: status ?? this.status,
      stdout: stdout ?? this.stdout,
      stderr: stderr ?? this.stderr,
      error: error ?? this.error,
      exitCode: exitCode ?? this.exitCode,
      devices: devices ?? this.devices,
    );
  }
}

class ToolCallItem {
  final String id;
  final String name;
  final Map<String, dynamic> args;
  final String? deviceName;
  final ToolCallResult? result;

  ToolCallItem({
    required this.id,
    required this.name,
    required this.args,
    this.deviceName,
    this.result,
  });

  String get command => args['command']?.toString() ?? '';
  String get action => args['action']?.toString() ?? 'shell';

  bool get isRunning =>
      result?.status == 'queued' ||
      result?.status == 'running' ||
      (result == null);

  bool get isSuccess =>
      result?.status == 'succeeded' ||
      (result != null &&
          result?.status != 'failed' &&
          result?.status != 'timeout' &&
          result?.status != 'error' &&
          (result?.exitCode == 0 || result?.exitCode == null));

  bool get isFailed =>
      result?.status == 'failed' ||
      result?.status == 'timeout' ||
      result?.status == 'error' ||
      (result?.exitCode != null && result!.exitCode != 0);

  ToolCallItem copyWith({
    String? id,
    String? name,
    Map<String, dynamic>? args,
    String? deviceName,
    ToolCallResult? result,
  }) {
    return ToolCallItem(
      id: id ?? this.id,
      name: name ?? this.name,
      args: args ?? this.args,
      deviceName: deviceName ?? this.deviceName,
      result: result ?? this.result,
    );
  }
}

class AskSource {
  final String id;
  final String toolId;
  final String? relativePath;
  final String? category;
  final String? title;
  final String? snippet;

  AskSource({
    required this.id,
    required this.toolId,
    this.relativePath,
    this.category,
    this.title,
    this.snippet,
  });

  factory AskSource.fromJson(Map<String, dynamic> json) {
    return AskSource(
      id: json['id']?.toString() ?? '',
      toolId: json['tool_id']?.toString() ?? '',
      relativePath: json['relative_path']?.toString(),
      category: json['category']?.toString(),
      title: json['title']?.toString(),
      snippet: json['snippet']?.toString(),
    );
  }
}

class AskTurn {
  final String role; // 'user' | 'assistant'
  final String content;
  final String? thinking;
  final bool error;
  final List<AskSource> sources;
  final List<ToolCallItem> toolCalls;

  AskTurn({
    required this.role,
    required this.content,
    this.thinking,
    this.error = false,
    this.sources = const [],
    this.toolCalls = const [],
  });

  AskTurn copyWith({
    String? role,
    String? content,
    String? thinking,
    bool? error,
    List<AskSource>? sources,
    List<ToolCallItem>? toolCalls,
  }) {
    return AskTurn(
      role: role ?? this.role,
      content: content ?? this.content,
      thinking: thinking ?? this.thinking,
      error: error ?? this.error,
      sources: sources ?? this.sources,
      toolCalls: toolCalls ?? this.toolCalls,
    );
  }
}

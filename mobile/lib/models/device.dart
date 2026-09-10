class Device {
  final String id;
  final String deviceId;
  final String name;
  final String? platform;
  final String? collectorVersion;
  final String? lastHeartbeat;
  final DateTime? lastHeartbeatTime;
  final int documentCount;
  final List<String> tools;
  final String? ip;
  final bool isOnline;

  Device({
    this.id = '',
    required this.deviceId,
    required this.name,
    this.platform,
    this.collectorVersion,
    this.lastHeartbeat,
    this.lastHeartbeatTime,
    this.documentCount = 0,
    this.tools = const [],
    this.ip,
    this.isOnline = false,
  });

  String get heartbeatText {
    if (lastHeartbeatTime == null) return '从未同步';
    final now = DateTime.now().toUtc();
    final diff = now.difference(lastHeartbeatTime!);
    if (diff.isNegative || diff.inSeconds < 60) return '刚刚';
    if (diff.inMinutes < 60) return '${diff.inMinutes} 分钟前';
    if (diff.inHours < 24) return '${diff.inHours} 小时前';
    return '${diff.inDays} 天前';
  }

  factory Device.fromJson(Map<String, dynamic> json) {
    final heartbeatStr = (json['last_heartbeat'] ?? json['last_seen']) as String?;
    DateTime? heartbeatTime;
    bool isOnline = false;

    if (heartbeatStr != null && heartbeatStr.isNotEmpty) {
      try {
        heartbeatTime = DateTime.parse(heartbeatStr).toUtc();
        final nowUtc = DateTime.now().toUtc();
        final diffSec = nowUtc.difference(heartbeatTime).inSeconds;
        // In Memento web client, online if heartbeat is within 5 minutes (300 seconds)
        isOnline = diffSec >= 0 && diffSec < 300;
      } catch (_) {}
    }

    final rawTools = json['tools'];
    List<String> toolsList = [];
    if (rawTools is List) {
      toolsList = rawTools.map((e) => e.toString()).toList();
    }

    return Device(
      id: json['id']?.toString() ?? '',
      deviceId: json['device_id']?.toString() ?? '',
      name: json['name']?.toString() ?? '未知设备',
      platform: json['platform']?.toString(),
      collectorVersion: json['collector_version']?.toString(),
      lastHeartbeat: heartbeatStr,
      lastHeartbeatTime: heartbeatTime,
      documentCount: (json['document_count'] as num?)?.toInt() ?? 0,
      tools: toolsList,
      ip: json['ip']?.toString(),
      isOnline: isOnline,
    );
  }
}

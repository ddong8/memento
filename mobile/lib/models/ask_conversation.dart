class AskConversationSummary {
  final String id;
  final String title;
  final String? deviceId;
  final int messageCount;
  final DateTime? createdAt;
  final DateTime? updatedAt;

  AskConversationSummary({
    required this.id,
    required this.title,
    this.deviceId,
    this.messageCount = 0,
    this.createdAt,
    this.updatedAt,
  });

  factory AskConversationSummary.fromJson(Map<String, dynamic> json) {
    DateTime? parseDate(dynamic d) {
      if (d == null) return null;
      try {
        return DateTime.parse(d.toString());
      } catch (_) {
        return null;
      }
    }

    return AskConversationSummary(
      id: json['id']?.toString() ?? '',
      title: json['title']?.toString() ?? '新对话',
      deviceId: json['device_id']?.toString(),
      messageCount: (json['message_count'] as num?)?.toInt() ?? 0,
      createdAt: parseDate(json['created_at']),
      updatedAt: parseDate(json['updated_at']),
    );
  }

  String get timeFormatted {
    final date = updatedAt ?? createdAt;
    if (date == null) return '';
    final now = DateTime.now();
    final diff = now.difference(date.toLocal());
    if (diff.inSeconds < 60) return '刚刚';
    if (diff.inMinutes < 60) return '${diff.inMinutes} 分钟前';
    if (diff.inHours < 24) return '${diff.inHours} 小时前';
    if (diff.inDays < 7) return '${diff.inDays} 天前';
    return '${date.month}月${date.day}日';
  }
}

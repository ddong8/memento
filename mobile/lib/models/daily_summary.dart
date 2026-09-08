class DailyDate {
  final String date;
  final int documentCount;
  final List<String> tools;

  DailyDate({
    required this.date,
    required this.documentCount,
    this.tools = const [],
  });

  factory DailyDate.fromJson(Map<String, dynamic> json) {
    return DailyDate(
      date: json['date']?.toString() ?? '',
      documentCount: json['document_count'] as int? ?? 0,
      tools: (json['tools'] as List<dynamic>?)?.map((e) => e.toString()).toList() ?? [],
    );
  }
}

class DailySummaryItem {
  final String id;
  final String? toolId;
  final String title;
  final String summary;

  DailySummaryItem({
    required this.id,
    this.toolId,
    required this.title,
    required this.summary,
  });

  factory DailySummaryItem.fromJson(Map<String, dynamic> json) {
    return DailySummaryItem(
      id: json['id']?.toString() ?? '',
      toolId: json['tool_id']?.toString(),
      title: json['title']?.toString() ?? '工作概要',
      summary: json['summary']?.toString() ?? '',
    );
  }
}

class DailyDetail {
  final String date;
  final int totalDocuments;
  final List<DailySummaryItem> summaries;

  DailyDetail({
    required this.date,
    required this.totalDocuments,
    required this.summaries,
  });

  factory DailyDetail.fromJson(Map<String, dynamic> json) {
    final summariesJson = json['summaries'] as List<dynamic>? ?? [];
    return DailyDetail(
      date: json['date']?.toString() ?? '',
      totalDocuments: json['total_documents'] as int? ?? 0,
      summaries: summariesJson
          .map((s) => DailySummaryItem.fromJson(s as Map<String, dynamic>))
          .toList(),
    );
  }
}
